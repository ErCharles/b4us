'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const stopsRoute = require('../src/routes/stops');
const sseRoute = require('../src/routes/sse');

const { normalizeStopTimes, normalizeStops } = stopsRoute;
const { normalizeForSSE } = sseRoute;

test('normalizeStops returns [] for empty input', () => {
    assert.deepEqual(normalizeStops(null), []);
    assert.deepEqual(normalizeStops({}), []);
    assert.deepEqual(normalizeStops({ stops: { Stop: null } }), []);
});

test('normalizeStops wraps a single stop into array', () => {
    const input = { stops: { Stop: { codStop: '8_1', name: 'A' } } };
    const out = normalizeStops(input);
    assert.equal(out.length, 1);
    assert.equal(out[0].codStop, '8_1');
});

test('normalizeStops keeps an array as-is', () => {
    const input = { stops: { Stop: [{ codStop: '8_1' }, { codStop: '8_2' }] } };
    const out = normalizeStops(input);
    assert.equal(out.length, 2);
});

test('normalizeStopTimes returns empty arrivals on null', () => {
    const out = normalizeStopTimes({}, '8_99');
    assert.equal(out.codStop, '8_99');
    assert.deepEqual(out.arrivals, []);
});

test('normalizeStopTimes computes secondsLeft from arrivalTime', () => {
    const future = new Date(Date.now() + 90000).toISOString();
    const data = {
        stopTimes: {
            stop: { name: 'AV.ONU' },
            times: { Time: [
                { time: future, line: { codLine: '8__521___', shortDescription: '521' }, destination: 'MADRID' },
            ]},
        },
    };
    const out = normalizeStopTimes(data, '8_08554');
    assert.equal(out.arrivals.length, 1);
    assert.equal(out.arrivals[0].line, '521');
    assert.ok(out.arrivals[0].secondsLeft > 80 && out.arrivals[0].secondsLeft < 100);
});

test('normalizeStopTimes sorts arrivals by secondsLeft', () => {
    const t1 = new Date(Date.now() + 300000).toISOString();
    const t2 = new Date(Date.now() + 60000).toISOString();
    const data = {
        stopTimes: {
            times: { Time: [
                { time: t1, line: { shortDescription: '521' } },
                { time: t2, line: { shortDescription: '523' } },
            ]},
        },
    };
    const out = normalizeStopTimes(data, '8_x');
    assert.equal(out.arrivals[0].line, '523');
    assert.equal(out.arrivals[1].line, '521');
});

test('normalizeForSSE includes type=update on real data', () => {
    const data = {
        stopTimes: {
            stop: { name: 'X' },
            times: { Time: [
                { time: new Date(Date.now() + 30000).toISOString(), line: { shortDescription: '521' } },
            ]},
        },
    };
    const out = normalizeForSSE(data, '8_1');
    assert.equal(out.type, 'update');
    assert.equal(out.arrivals.length, 1);
});

test('normalizeForSSE returns empty stub when stopTimes absent', () => {
    const out = normalizeForSSE({}, '8_2');
    assert.equal(out.type, 'empty');
    assert.deepEqual(out.arrivals, []);
});

test('normalizeStopTimes handles negative arrival times gracefully', () => {
    const past = new Date(Date.now() - 30000).toISOString();
    const data = {
        stopTimes: {
            times: { Time: [
                { time: past, line: { shortDescription: '521' } },
            ]},
        },
    };
    const out = normalizeStopTimes(data, '8_x');
    // diff clamped to 0 → secondsLeft is 0
    assert.equal(out.arrivals[0].secondsLeft, 0);
    assert.equal(out.arrivals[0].minutesLeft, 0);
});
