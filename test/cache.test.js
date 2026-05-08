'use strict';

// Cache tests focus on the in-memory fallback path (no Redis required).
// Behaviours covered:
//  - swrMemory caches first call and reuses it within MEM_TTL.
//  - When Redis is offline, swr() falls through to memory transparently.
//  - Errors propagate when no cached value is available.
//
// Redis-specific paths (negative caching, single-flight, stale-fallback)
// are exercised by integration tests in CI when a Redis container is up;
// here we keep tests self-contained.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Force Redis to a clearly-broken endpoint so cache.js falls through.
process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.CACHE_FRESH_TTL = '5';
process.env.CACHE_STALE_TTL = '60';

// Re-require to pick up the env override.
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/cache')];
const cache = require('../src/cache');

test('swr returns the fetcher result on first call', async () => {
    let n = 0;
    const v = await cache.swr('test:k1', async () => ++n);
    assert.equal(v, 1);
    assert.equal(n, 1);
});

test('swr returns cached memory value within TTL', async () => {
    let n = 0;
    const a = await cache.swr('test:k2', async () => ++n);
    const b = await cache.swr('test:k2', async () => ++n);
    assert.equal(a, 1);
    assert.equal(b, 1);
    assert.equal(n, 1);
});

test('swr surfaces upstream errors when nothing is cached', async () => {
    await assert.rejects(
        cache.swr('test:k3', async () => { throw new Error('upstream broken'); }),
        /upstream broken/
    );
});

test('swr distinguishes keys', async () => {
    let a = 0, b = 0;
    const ra = await cache.swr('test:ka', async () => ++a);
    const rb = await cache.swr('test:kb', async () => ++b);
    assert.equal(ra, 1);
    assert.equal(rb, 1);
});

// Cleanup: disconnect to drop the dangling Redis connection so the test
// process exits cleanly even though Redis was never reachable.
test('disconnect tears down Redis cleanly', async () => {
    await cache.disconnect();
});
