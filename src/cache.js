'use strict';

const Redis = require('ioredis');
const config = require('./config');
const metrics = require('./metrics');
const logger = require('./logger');

let redis;

function getRedis() {
    if (!redis) {
        redis = new Redis(config.redis.url, {
            maxRetriesPerRequest: 3,
            retryStrategy(times) {
                return Math.min(times * 200, 3000);
            },
            lazyConnect: true,
        });
        redis.on('error', (err) =>
            logger.get().warn(
                { kind: 'app', component: 'redis', err: err.message || err.code || String(err) },
                'Redis error'
            )
        );
    }
    return redis;
}

/**
 * SWR (Stale-While-Revalidate) cache with single-flight lock,
 * stale-as-fallback on upstream failure, and negative caching.
 *
 * Keys in Redis:
 *   data:<key>  — JSON stringified payload    (TTL = STALE_TTL × 2)
 *   ts:<key>    — timestamp (ms) when stored  (same TTL)
 *   lock:<key>  — single-flight mutex (NX + PX)
 *   err:<key>   — most recent upstream error  (TTL = NEG_TTL, default 30s)
 *
 * Behaviour summary:
 *   - Fresh hit  → return cached, metric=fresh.
 *   - Stale hit  → return cached + spawn background revalidation (single-flight). metric=stale.
 *   - Miss + recent error cached → throw cached error. metric=miss.
 *   - Miss → fetch; on success clear err:; on failure return stale-extended if available
 *           (data: still in Redis past STALE), else cache err: 30s and rethrow.
 *
 * Falls back to an in-memory cache when Redis is offline.
 */

const FRESH = config.cache.freshTtl;
const STALE = config.cache.staleTtl;
const LOCK = config.cache.lockTtl;
const NEG_TTL = config.cache.negativeTtl;

// In-memory fallback cache for when Redis is offline
const memCache = new Map();
const MEM_TTL = config.cache.freshTtl * 1000; // ms

async function swr(key, fetchFn) {
    const r = getRedis();

    if (r.status !== 'ready') {
        return swrMemory(key, fetchFn);
    }

    const dataKey = `data:${key}`;
    const tsKey = `ts:${key}`;
    const lockKey = `lock:${key}`;
    const errKey = `err:${key}`;

    try {
        const [raw, tsRaw, errRaw] = await r.mget(dataKey, tsKey, errKey);

        if (raw && tsRaw) {
            const age = (Date.now() - Number(tsRaw)) / 1000;

            if (age < FRESH) {
                metrics.inc('swrCacheEvents', { state: 'fresh' });
                return JSON.parse(raw);
            }

            if (age < STALE) {
                metrics.inc('swrCacheEvents', { state: 'stale' });
                if (!errRaw) {
                    // Only revalidate if we don't already know upstream is broken.
                    const acquired = await r.set(lockKey, '1', 'NX', 'PX', LOCK * 1000);
                    if (acquired) {
                        revalidate(r, key, fetchFn, dataKey, tsKey, lockKey, errKey).catch((err) =>
                            logger.get().warn(
                                { kind: 'app', component: 'swr', key, err: err.message },
                                'Background revalidation failed'
                            )
                        );
                    }
                }
                return JSON.parse(raw);
            }
        }

        // Past STALE OR cold miss. If upstream is known-broken, decide based on what we have:
        if (errRaw) {
            if (raw) {
                // We have extra-stale data and upstream is broken → serve it as fallback.
                metrics.inc('swrCacheEvents', { state: 'stale_fallback' });
                return JSON.parse(raw);
            }
            metrics.inc('swrCacheEvents', { state: 'miss' });
            const cachedErr = parseCachedError(errRaw);
            throw cachedErr;
        }

        // Acquire lock and fetch
        const acquired = await r.set(lockKey, '1', 'NX', 'PX', LOCK * 2 * 1000);
        if (acquired || !raw) {
            try {
                const data = await fetchFn();
                metrics.inc('swrCacheEvents', { state: 'miss' });
                await persist(r, dataKey, tsKey, data);
                await r.del(lockKey, errKey);
                return data;
            } catch (err) {
                await r.del(lockKey);
                // Cache the error briefly so we don't hammer upstream
                await r.set(errKey, JSON.stringify({ message: err.message, code: err.code, statusCode: err.statusCode }), 'EX', NEG_TTL);
                if (raw) {
                    // Stale-extended fallback
                    metrics.inc('swrCacheEvents', { state: 'stale_fallback' });
                    logger.get().warn(
                        { kind: 'app', component: 'swr', key, err: err.message },
                        'Returning stale data after fetch failure'
                    );
                    return JSON.parse(raw);
                }
                throw err;
            }
        }

        // Someone else owns the lock — wait briefly and retry from cache
        await new Promise((resolve) => setTimeout(resolve, 800));
        const retryRaw = await r.get(dataKey);
        if (retryRaw) {
            metrics.inc('swrCacheEvents', { state: 'stale' });
            return JSON.parse(retryRaw);
        }

        // Last resort: fetch ourselves
        try {
            const data = await fetchFn();
            metrics.inc('swrCacheEvents', { state: 'miss' });
            await persist(r, dataKey, tsKey, data);
            await r.del(errKey);
            return data;
        } catch (err) {
            await r.set(errKey, JSON.stringify({ message: err.message, code: err.code, statusCode: err.statusCode }), 'EX', NEG_TTL);
            throw err;
        }
    } catch (err) {
        if (err && err.code === 'CIRCUIT_OPEN') throw err;
        if (err && err.upstream) throw err;
        // Treat anything else as Redis-level error — fall back to memory cache.
        logger.get().warn(
            { kind: 'app', component: 'swr', key, err: err.message },
            'Redis error, using memory fallback'
        );
        metrics.inc('swrCacheEvents', { state: 'memory' });
        return swrMemory(key, fetchFn);
    }
}

async function swrMemory(key, fetchFn) {
    const cached = memCache.get(key);
    if (cached && Date.now() - cached.ts < MEM_TTL) {
        return cached.data;
    }
    const data = await fetchFn();
    memCache.set(key, { data, ts: Date.now() });
    if (memCache.size > 500) {
        const oldest = memCache.keys().next().value;
        memCache.delete(oldest);
    }
    return data;
}

async function revalidate(r, key, fetchFn, dataKey, tsKey, lockKey, errKey) {
    try {
        const data = await fetchFn();
        await persist(r, dataKey, tsKey, data);
        await r.del(errKey);
    } catch (err) {
        await r.set(
            errKey,
            JSON.stringify({ message: err.message, code: err.code, statusCode: err.statusCode }),
            'EX',
            NEG_TTL
        );
        throw err;
    } finally {
        await r.del(lockKey);
    }
}

async function persist(r, dataKey, tsKey, data) {
    const pipeline = r.pipeline();
    pipeline.set(dataKey, JSON.stringify(data), 'EX', STALE * 2);
    pipeline.set(tsKey, String(Date.now()), 'EX', STALE * 2);
    await pipeline.exec();
}

function parseCachedError(raw) {
    try {
        const o = JSON.parse(raw);
        const e = new Error(o.message || 'Upstream error (cached)');
        if (o.code) e.code = o.code;
        if (o.statusCode) e.statusCode = o.statusCode;
        e.cached = true;
        e.upstream = true;
        return e;
    } catch {
        const e = new Error('Upstream error (cached)');
        e.upstream = true;
        e.cached = true;
        return e;
    }
}

async function invalidate(key) {
    const r = getRedis();
    await r.del(`data:${key}`, `ts:${key}`, `lock:${key}`, `err:${key}`);
}

async function disconnect() {
    if (redis) {
        await redis.quit();
        redis = null;
    }
}

module.exports = { swr, invalidate, getRedis, disconnect };
