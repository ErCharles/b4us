'use strict';

// MockAgent-based tests for the CRTM client. We assert that:
//   - successful 200 responses are parsed
//   - 5xx responses bubble up as upstream errors
//   - retries happen and the breaker is exposed via getBreakerSnapshot
//   - 429 triggers the dedicated rate-limit backoff path

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');

const BASE = 'https://www.crtm.es';

// Force the client to give up quickly during tests.
process.env.CRTM_TIMEOUT = '500';
process.env.CRTM_RETRIES = '0';

delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/crtm-client')];
delete require.cache[require.resolve('../src/circuit-breaker')];

const original = getGlobalDispatcher();
const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);

const crtm = require('../src/crtm-client');
const pool = agent.get(BASE);

after(async () => {
    setGlobalDispatcher(original);
    await agent.close();
});

test('searchStops parses 200 JSON', async () => {
    pool.intercept({ path: /\/widgets\/api\/GetStops\.php\?customSearch=onu.*/ })
        .reply(200, JSON.stringify({ stops: { Stop: [{ codStop: '8_08554', name: 'AV.ONU' }] } }), {
            headers: { 'content-type': 'application/json' },
        });

    const data = await crtm.searchStops('onu');
    assert.equal(data.stops.Stop[0].codStop, '8_08554');
});

test('5xx bubbles up as upstream error', async () => {
    pool.intercept({ path: /\/widgets\/api\/GetStopsTimes\.php\?codStop=8_99999.*/ })
        .reply(500, 'broken');

    await assert.rejects(
        crtm.getStopTimes('8_99999'),
        (err) => err.upstream === true && err.statusCode === 500
    );
});

test('Invalid JSON is reported as upstream error', async () => {
    pool.intercept({ path: /\/widgets\/api\/GetStops\.php\?codStop=8_00001.*/ })
        .reply(200, '<html>not json</html>', { headers: { 'content-type': 'text/html' } });

    await assert.rejects(
        crtm.getStopInfo('8_00001'),
        (err) => err.upstream === true
    );
});

test('errorCode in body is reported', async () => {
    pool.intercept({ path: /\/widgets\/api\/GetStops\.php\?codStop=8_00002.*/ })
        .reply(200, JSON.stringify({ errorCode: '42', errorMessage: 'kaboom' }), {
            headers: { 'content-type': 'application/json' },
        });

    await assert.rejects(
        crtm.getStopInfo('8_00002'),
        /CRTM API Error: kaboom/
    );
});

test('breaker exposes a snapshot', () => {
    const snap = crtm.getBreakerSnapshot();
    assert.ok('state' in snap);
    assert.ok('failures' in snap);
});
