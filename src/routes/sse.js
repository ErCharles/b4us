'use strict';

const crtm = require('../crtm-client');
const { swr } = require('../cache');
const config = require('../config');
const metrics = require('../metrics');
const logger = require('../logger');
const { normalizeStopTimes } = require('./stops');

const HEARTBEAT_MS = config.sse.heartbeatInterval;
const UPDATE_MS = config.sse.updateInterval;
const LIVE_OPTS = { freshTtl: config.cache.liveFreshTtl, negativeTtl: config.cache.liveNegativeTtl };

const codStopParams = {
    type: 'object',
    properties: { codStop: { type: 'string', pattern: '^\\d+_\\d+$', maxLength: 20 } },
    required: ['codStop'],
    additionalProperties: false,
};

// ONE poller per codStop, shared by all of its subscribers. The first
// subscriber spins up the timers; the last to leave tears them down. Each
// tick does a SINGLE upstream fetch and serialises the SSE frame ONCE, then
// writes the same bytes to every subscriber. Cost is O(active stops), not
// O(connections): 50 people watching the same stop = 1 fetch / 5 s, not 50.
const pollers = new Map(); // codStop -> { subs:Set<raw>, timer, heartbeat, lastFrame, id, inflight }
let totalConnections = 0;

function broadcast(p, frame) {
    for (const raw of p.subs) {
        try { raw.write(frame); } catch { /* dropped socket; its close handler unsubscribes */ }
    }
}

async function tick(codStop, p) {
    if (p.inflight) return; // skip overlap when upstream is slow (timeout×retry > UPDATE_MS)
    p.inflight = true;
    try {
        const data = await fetchStopTimes(codStop);
        p.lastFrame = sseFrame('update', data, ++p.id);
        broadcast(p, p.lastFrame);
    } catch (err) {
        // Keep the last good snapshot as lastFrame for late joiners; just push an error tick.
        broadcast(p, sseFrame('error', { message: 'Update failed', codStop, code: err.code }, ++p.id));
    } finally {
        p.inflight = false;
    }
}

function getPoller(codStop) {
    let p = pollers.get(codStop);
    if (p) return p;
    p = { subs: new Set(), timer: null, heartbeat: null, lastFrame: null, id: 0, inflight: false };
    pollers.set(codStop, p);
    p.timer = setInterval(() => { tick(codStop, p).catch(() => {}); }, UPDATE_MS);
    p.heartbeat = setInterval(() => broadcast(p, ': heartbeat\n\n'), HEARTBEAT_MS);
    return p;
}

function removeSub(codStop, raw) {
    const p = pollers.get(codStop);
    if (!p) return;
    if (p.subs.delete(raw)) {
        totalConnections = Math.max(0, totalConnections - 1);
        metrics.set('sseConnections', totalConnections);
    }
    if (p.subs.size === 0) {
        clearInterval(p.timer);
        clearInterval(p.heartbeat);
        pollers.delete(codStop);
    }
}

async function sseRoutes(fastify) {
    // SSE stream for a specific stop
    fastify.get('/api/sse/stop/:codStop', {
        schema: { params: codStopParams },
        // Disable global compression — chunked SSE must not be buffered.
        config: { compress: false },
    }, async (req, reply) => {
        const { codStop } = req.params;
        const raw = reply.raw;

        raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            'X-Content-Type-Options': 'nosniff',
            ...corsHeaders(req),
        });
        raw.flushHeaders();

        // 2 KiB comment padding defeats output buffering in intermediate
        // proxies (notably cloudflared) so the first update reaches the browser.
        raw.write(': ' + ' '.repeat(2048) + '\n\n');
        raw.write('retry: 5000\n\n');

        const p = getPoller(codStop);
        p.subs.add(raw);
        totalConnections += 1;
        metrics.set('sseConnections', totalConnections);

        // Instant paint: a late joiner gets the last broadcast frame as-is;
        // a cold poller fetches now (which broadcasts to this subscriber too).
        if (p.lastFrame) {
            try { raw.write(p.lastFrame); } catch { /* closed already */ }
        } else {
            tick(codStop, p).catch(() => {});
        }

        let closed = false;
        const cleanup = () => { if (!closed) { closed = true; removeSub(codStop, raw); } };
        req.raw.on('close', cleanup);
        req.raw.on('error', cleanup);

        reply.hijack();
    });

    fastify.get('/api/sse/stats', async () => {
        const byStop = {};
        for (const [codStop, p] of pollers) byStop[codStop] = p.subs.size;
        return { totalConnections, activeStops: pollers.size, byStop };
    });
}

async function fetchStopTimes(codStop) {
    const key = `stops:times:${codStop}`;
    const data = await swr(key, () => crtm.getStopTimes(codStop), LIVE_OPTS);
    const payload = normalizeStopTimes(data, codStop);
    payload.type = 'update';
    return payload;
}

function sseFrame(event, data, id) {
    let s = '';
    if (id !== undefined) s += `id: ${id}\n`;
    s += `event: ${event}\n`;
    s += `data: ${JSON.stringify(data)}\n\n`;
    return s;
}

// CORS for the hijacked raw response — @fastify/cors can't set headers on a
// stream we write directly, so mirror the same allowlist here.
function corsHeaders(req) {
    const origin = req.headers.origin;
    if (origin && config.isAllowedOrigin(origin)) {
        return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    }
    return {};
}

function getConnectionCount() {
    return totalConnections;
}

module.exports = sseRoutes;
module.exports.getConnectionCount = getConnectionCount;
