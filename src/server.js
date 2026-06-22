'use strict';

const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const config = require('./config');
const { disconnect, getRedis } = require('./cache');
const metrics = require('./metrics');
const logger = require('./logger');

// Content-Security-Policy for the frontend. The single inline <script> in
// index.html (the <base> bootstrap) is allowed by its sha256 hash — NO
// 'unsafe-inline' for scripts. If that inline script ever changes, regenerate
// the hash (see public/index.html) or the page will break.
const CSP = [
    "default-src 'self'",
    "script-src 'self' https://unpkg.com 'sha256-ehUfJkAtW9GMvE94R2ICDuU7/bgIox0JxHXtOCy1l7k='",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
    "img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org https://unpkg.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "connect-src 'self' https://b4us.pigeon-cobia.ts.net",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
].join('; ');

async function start() {
    const fastify = Fastify({
        logger: { level: process.env.LOG_LEVEL || 'info' },
        trustProxy: true,
        disableRequestLogging: false,
    });

    // Make our shared logger forward to Fastify's Pino instance so every
    // structured log line carries reqId/responseTime when relevant.
    logger.set(fastify.log);

    // Security headers on every (non-hijacked) response. Cheap, no dependency.
    fastify.addHook('onRequest', async (req, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
        reply.header('X-Frame-Options', 'DENY');
        reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        reply.header('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
        reply.header('Content-Security-Policy', CSP);
    });

    // ---------- Error handler ----------
    // Set BEFORE registering plugins so it lives at the root scope and
    // every encapsulated child route inherits it.
    fastify.setErrorHandler((error, req, reply) => {
        // Schema validation errors → 400 with a helpful message.
        if (error.validation) {
            req.log.warn(
                { kind: 'app', component: 'validation', err: error.message, validation: error.validation },
                'Validation error'
            );
            return reply.code(400).send({
                error: 'Bad Request',
                statusCode: 400,
                details: error.validation,
            });
        }

        // Upstream-classified errors → log with kind:upstream, surface as 502/503.
        if (error.upstream || error.code === 'CIRCUIT_OPEN') {
            const retryable = error.code === 'CIRCUIT_OPEN' || error.statusCode === 429;
            const status = error.code === 'CIRCUIT_OPEN' ? 503 : 502;
            if (retryable) reply.header('Retry-After', '15');
            req.log.warn(
                {
                    kind: 'upstream',
                    err: error.message,
                    code: error.code,
                    upstreamStatus: error.statusCode || null,
                    cached: !!error.cached,
                },
                'Upstream error returned to client'
            );
            return reply.code(status).send({
                error: 'Upstream temporarily unavailable',
                statusCode: status,
                code: error.code || 'UPSTREAM_ERROR',
            });
        }

        // App / unexpected errors → log with kind:app, generic 500.
        req.log.error(
            { kind: 'app', err: error.message, stack: error.stack },
            'Internal handler error'
        );
        const statusCode = error.statusCode || 500;
        return reply.code(statusCode).send({
            error: statusCode >= 500 ? 'Internal Server Error' : error.message,
            statusCode,
        });
    });

    // Compression — register before any handlers / static so all responses
    // including .html/.js/.css are eligible. SSE is opt-out (no buffering).
    await fastify.register(require('@fastify/compress'), {
        global: true,
        encodings: ['br', 'gzip', 'deflate'],
        threshold: 1024,
    });

    // Weak ETag for any JSON/HTML response — gives navigators a free 304.
    await fastify.register(require('@fastify/etag'), { weak: true });

    // CORS — allowlist (shared with the SSE raw-response path) instead of
    // reflecting any Origin.
    await fastify.register(require('@fastify/cors'), {
        origin: (origin, cb) => cb(null, config.isAllowedOrigin(origin)),
        methods: ['GET', 'OPTIONS'],
        maxAge: 86400,
    });

    // Rate limiting
    await fastify.register(require('@fastify/rate-limit'), {
        max: config.rateLimit.max,
        timeWindow: config.rateLimit.timeWindow,
        keyGenerator: (req) => req.ip,
    });

    // Prometheus metrics — also wires HTTP histogram + summary by route.
    await fastify.register(require('fastify-metrics'), {
        endpoint: '/metrics',
        defaultMetrics: { enabled: true },
        routeMetrics: { enabled: true },
    });
    metrics.init(fastify.metrics.client);

    // Guard /metrics: behind a public tunnel we don't want the upstream
    // failure histogram leaking, and "loopback" doesn't help inside Docker
    // (req.ip is the bridge gateway, not 127.0.0.1). When METRICS_TOKEN is
    // set, require it on every scrape — Prometheus carries it via header,
    // an admin opening it from a browser appends ?token=…
    const metricsToken = process.env.METRICS_TOKEN;
    if (metricsToken) {
        fastify.addHook('onRequest', async (req, reply) => {
            if (req.url.startsWith('/metrics')) {
                const tok = req.query?.token || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.headers['x-metrics-token'];
                if (tok !== metricsToken) {
                    // `return` so the handler stops here — without it the metrics
                    // body would still be assembled and could leak.
                    return reply.code(401).send({ error: 'Unauthorized' });
                }
            }
        });
    }

    // Static files (frontend) with sensible cache headers.
    await fastify.register(require('@fastify/static'), {
        root: path.join(__dirname, '..', 'public'),
        prefix: '/',
        setHeaders(res, p) {
            // Hashed assets get long cache; everything else short revalidate.
            if (/\.[a-f0-9]{8,}\.(js|css|woff2?|svg|png|webp)$/i.test(p)) {
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            } else if (/\.(html|webmanifest|json)$/i.test(p) || /\/sw\.js$/.test(p)) {
                // Index/manifest/SW must always be revalidated to ship updates.
                res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
            } else {
                res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
            }
        },
    });

    // API routes
    await fastify.register(require('./routes/stops'));
    await fastify.register(require('./routes/lines'));
    await fastify.register(require('./routes/sse'));

    // ---------- Pages: deep links + privacy + manifest ----------
    const publicDir = path.join(__dirname, '..', 'public');
    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    const privacyHtml = fs.existsSync(path.join(publicDir, 'privacy.html'))
        ? fs.readFileSync(path.join(publicDir, 'privacy.html'), 'utf8')
        : null;

    function sendIndex(reply) {
        reply.header('Content-Type', 'text/html; charset=utf-8');
        reply.header('Cache-Control', 'public, max-age=0, must-revalidate');
        return reply.send(indexHtml);
    }

    // Shareable deep link to a stop. The SPA reads location.pathname on boot.
    fastify.get('/stop/:codStop', {
        schema: {
            params: {
                type: 'object',
                properties: { codStop: { type: 'string', pattern: '^\\d+_\\d+$' } },
                required: ['codStop'],
            },
        },
    }, (req, reply) => sendIndex(reply));

    // /privacy serves a static HTML page (legal disclaimer + privacy notice).
    fastify.get('/privacy', (req, reply) => {
        if (!privacyHtml) {
            reply.code(404);
            return reply.send({ error: 'Not found' });
        }
        reply.header('Content-Type', 'text/html; charset=utf-8');
        reply.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
        return reply.send(privacyHtml);
    });

    // ---------- Health / readiness ----------
    // Race a Redis ping against a 1s timeout so probes stay snappy.
    async function pingRedis() {
        const redis = getRedis();
        if (redis.status !== 'ready') return false;
        try {
            const pong = await Promise.race([
                redis.ping(),
                new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 1000)),
            ]);
            return pong === 'PONG';
        } catch { return false; }
    }

    // /health: rich diagnostics, always 200 (liveness — is the process up?).
    // logLevel 'warn' keeps the every-30s probe out of the request log.
    fastify.get('/health', { logLevel: 'warn' }, async (req, reply) => {
        const redisOk = await pingRedis();
        const crtm = require('./crtm-client').getBreakerSnapshot();
        reply.header('Cache-Control', 'no-store');
        return {
            status: redisOk ? 'healthy' : 'degraded',
            redis: redisOk,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            connections: require('./routes/sse').getConnectionCount(),
            crtmBreaker: { state: crtm.state, failures: crtm.failures, openedAt: crtm.openedAt },
        };
    });

    // /ready: readiness for the container healthcheck — 503 (NOT ready) when
    // Redis is down or every CRTM breaker is open, so Docker actually restarts
    // a backend that's wedged instead of leaving a permanently-degraded one up.
    fastify.get('/ready', { logLevel: 'warn' }, async (req, reply) => {
        const redisOk = await pingRedis();
        const crtm = require('./crtm-client').getBreakerSnapshot();
        const ready = redisOk && crtm.state !== 2; // 2 = OPEN
        reply.header('Cache-Control', 'no-store');
        reply.code(ready ? 200 : 503);
        return { ready, redis: redisOk, crtmBreaker: crtm.state };
    });

    // ---------- Graceful shutdown ----------
    const shutdown = async (signal) => {
        fastify.log.info({ kind: 'app', signal }, 'shutting down');
        await fastify.close();
        await disconnect();
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Connect to Redis eagerly (best-effort)
    try {
        const redis = getRedis();
        await redis.connect();
        fastify.log.info({ kind: 'app', component: 'redis' }, 'Redis connected');
    } catch (err) {
        fastify.log.warn({ kind: 'app', component: 'redis', err: err.message }, 'Redis connection deferred');
    }

    await fastify.listen({ port: config.port, host: config.host });
    fastify.log.info({ kind: 'app', port: config.port }, 'CRTM ETA Platform running');
}

start().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
