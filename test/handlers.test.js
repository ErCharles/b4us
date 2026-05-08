'use strict';

// Handler-level tests using Fastify's `inject()` so we never open a real socket.
//
// We don't talk to the real CRTM upstream — we register only the stops/lines
// routes against a stub `crtm-client` (via Node's module cache override).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// --- Stub the crtm-client and cache before they get required ---

const stubResponses = new Map();
function stubFor(name, fn) { stubResponses.set(name, fn); }

require.cache[require.resolve('../src/crtm-client')] = {
    id: require.resolve('../src/crtm-client'),
    filename: require.resolve('../src/crtm-client'),
    loaded: true,
    exports: new Proxy({}, {
        get(_t, prop) {
            if (prop === 'getBreakerSnapshot') return () => ({ state: 0, failures: 0, openedAt: null });
            return (...args) => {
                const fn = stubResponses.get(prop);
                if (!fn) return Promise.reject(new Error(`No stub for ${String(prop)}`));
                return Promise.resolve(fn(...args));
            };
        },
    }),
};

// Stub cache.swr to skip Redis entirely.
require.cache[require.resolve('../src/cache')] = {
    id: require.resolve('../src/cache'),
    filename: require.resolve('../src/cache'),
    loaded: true,
    exports: {
        swr: async (_key, fn) => fn(),
        invalidate: async () => {},
        getRedis: () => ({ ping: async () => 'PONG', status: 'ready' }),
        disconnect: async () => {},
    },
};

const Fastify = require('fastify');

let app;
before(async () => {
    app = Fastify({ logger: false });
    await app.register(require('../src/routes/stops'));
    await app.register(require('../src/routes/lines'));
});
after(async () => { if (app) await app.close(); });

test('GET /api/stops/:codStop with bad format returns 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stops/badformat' });
    assert.equal(res.statusCode, 400);
});

test('GET /api/stops/:codStop with valid format calls upstream and returns body', async () => {
    stubFor('getStopInfo', () => ({ stops: { Stop: { codStop: '8_08554', name: 'AV.ONU' } } }));
    const res = await app.inject({ method: 'GET', url: '/api/stops/8_08554' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.stops.Stop.codStop, '8_08554');
});

test('GET /api/stops/:codStop/times returns normalized arrivals', async () => {
    const future = new Date(Date.now() + 60000).toISOString();
    stubFor('getStopTimes', () => ({
        stopTimes: {
            stop: { name: 'AV.ONU' },
            times: { Time: [
                { time: future, line: { codLine: '8__521___', shortDescription: '521' }, destination: 'MADRID' },
            ]},
        },
    }));
    const res = await app.inject({ method: 'GET', url: '/api/stops/8_08554/times' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.arrivals.length, 1);
    assert.equal(body.arrivals[0].line, '521');
});

test('GET /api/stops/postcode/abc returns 400 (must be 5 digits)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stops/postcode/abc' });
    assert.equal(res.statusCode, 400);
});

test('GET /api/stops/postcode/28934 calls upstream', async () => {
    stubFor('getStopsByPostCode', () => ({ stops: { Stop: [{ codStop: '8_1' }] } }));
    const res = await app.inject({ method: 'GET', url: '/api/stops/postcode/28934' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().count, 1);
});

test('GET /api/stops/nearby validates lat range', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stops/nearby?lat=999&lng=0' });
    assert.equal(res.statusCode, 400);
});

test('GET /api/lines defaults mode to 8 (interurbano)', async () => {
    let received = null;
    stubFor('getLinesByMode', (mode) => { received = mode; return { lines: { Line: [] } }; });
    const res = await app.inject({ method: 'GET', url: '/api/lines' });
    assert.equal(res.statusCode, 200);
    assert.equal(received, 8);
});

test('GET /api/lines/:codLine with malformed codLine returns 400', async () => {
    // Special chars that Fastify accepts as a path segment but the regex rejects.
    const res = await app.inject({ method: 'GET', url: '/api/lines/abc%21' }); // "abc!"
    assert.equal(res.statusCode, 400);
});

test('Cache-Control is set on stable endpoints', async () => {
    stubFor('getStopInfo', () => ({ stops: { Stop: {} } }));
    const res = await app.inject({ method: 'GET', url: '/api/stops/8_1' });
    assert.match(res.headers['cache-control'], /max-age=300/);
    assert.match(res.headers['cache-control'], /stale-while-revalidate/);
});

test('Cache-Control is no-store on /times (volatile)', async () => {
    stubFor('getStopTimes', () => ({ stopTimes: { times: { Time: [] } } }));
    const res = await app.inject({ method: 'GET', url: '/api/stops/8_1/times' });
    assert.equal(res.headers['cache-control'], 'no-store');
});
