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

async function swr(key, fetchFn, opts = {}) {
    // Per-call overrides: live (ETA) keys use a shorter fresh window and a
    // shorter negative window than stable keys.
    const fresh = opts.freshTtl ?? FRESH;
    const negTtl = opts.negativeTtl ?? NEG_TTL;

    const r = getRedis();

    if (r.status !== 'ready') {
        return swrMemory(key, fetchFn);
    }

    const keys = {
        dataKey: `data:${key}`,
        tsKey: `ts:${key}`,
        lockKey: `lock:${key}`,
        errKey: `err:${key}`,
    };
    const { dataKey, tsKey, lockKey, errKey } = keys;

    try {
        const [raw, tsRaw, errRaw] = await r.mget(dataKey, tsKey, errKey);

        if (raw && tsRaw) {
            const age = (Date.now() - Number(tsRaw)) / 1000;

            if (age < fresh) {
                metrics.inc('swrCacheEvents', { state: 'fresh' });
                return JSON.parse(raw);
            }

            if (age < STALE) {
                metrics.inc('swrCacheEvents', { state: 'stale' });
                if (!errRaw) {
                    // Only revalidate if we don't already know upstream is broken.
                    const acquired = await r.set(lockKey, '1', 'NX', 'PX', LOCK * 1000);
                    if (acquired) {
                        revalidate(r, key, fetchFn, keys, negTtl).catch((err) =>
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
                metrics.inc('swrCacheEvents', { state: 'stale_fallback' });
                return JSON.parse(raw);
            }
            metrics.inc('swrCacheEvents', { state: 'miss' });
            throw parseCachedError(errRaw);
        }

        // Single-flight: ONLY the lock holder fetches upstream. (The old
        // `acquired || !raw` let every concurrent cold-miss request through —
        // a thundering herd against CRTM on expiry/startup.)
        const acquired = await r.set(lockKey, '1', 'NX', 'PX', LOCK * 2 * 1000);
        if (acquired) {
            metrics.inc('swrCacheEvents', { state: 'miss' });
            return await fetchAndStore(r, keys, fetchFn, negTtl, raw);
        }

        // Not the holder — wait briefly for it to populate the cache, then read.
        const populated = await waitForData(r, dataKey, LOCK);
        if (populated) {
            metrics.inc('swrCacheEvents', { state: 'stale' });
            return JSON.parse(populated);
        }

        // Holder failed or is too slow — fetch ourselves as a last resort.
        metrics.inc('swrCacheEvents', { state: 'miss' });
        return await fetchAndStore(r, keys, fetchFn, negTtl, raw);
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

// Single fetch+persist path shared by the cold-miss branches. On failure it
// caches the error (negative caching) and serves extra-stale `staleRaw` if
// we have it, else rethrows.
async function fetchAndStore(r, keys, fetchFn, negTtl, staleRaw) {
    const { dataKey, tsKey, lockKey, errKey } = keys;
    try {
        const data = await fetchFn();
        await persist(r, dataKey, tsKey, data);
        await r.del(lockKey, errKey);
        return data;
    } catch (err) {
        await r.del(lockKey);
        await r.set(errKey, JSON.stringify({ message: err.message, code: err.code, statusCode: err.statusCode }), 'EX', negTtl);
        if (staleRaw) {
            metrics.inc('swrCacheEvents', { state: 'stale_fallback' });
            logger.get().warn(
                { kind: 'app', component: 'swr', err: err.message },
                'Returning stale data after fetch failure'
            );
            return JSON.parse(staleRaw);
        }
        throw err;
    }
}

// Poll the data key while another request holds the single-flight lock.
async function waitForData(r, dataKey, lockSecs) {
    const deadline = Date.now() + lockSecs * 1000;
    while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 60));
        const v = await r.get(dataKey);
        if (v) return v;
    }
    return null;
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

async function revalidate(r, key, fetchFn, keys, negTtl) {
    const { dataKey, tsKey, lockKey, errKey } = keys;
    try {
        const data = await fetchFn();
        await persist(r, dataKey, tsKey, data);
        await r.del(errKey);
    } catch (err) {
        await r.set(
            errKey,
            JSON.stringify({ message: err.message, code: err.code, statusCode: err.statusCode }),
            'EX',
            negTtl
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

async function disconnect() {
    if (redis) {
        await redis.quit();
        redis = null;
    }
}

module.exports = { swr, getRedis, disconnect };
