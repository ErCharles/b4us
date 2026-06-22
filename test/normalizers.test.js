'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const stopsRoute = require('../src/routes/stops');

const { normalizeStopTimes, normalizeStops } = stopsRoute;

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

test('normalizeStopTimes returns empty + lineStatuses{} on null', () => {
    const out = normalizeStopTimes({}, '8_99');
    assert.equal(out.codStop, '8_99');
    assert.deepEqual(out.arrivals, []);
    assert.deepEqual(out.lineStatuses, {});
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

test('normalizeStopTimes clamps past arrivals to 0', () => {
    const past = new Date(Date.now() - 30000).toISOString();
    const data = { stopTimes: { times: { Time: [{ time: past, line: { shortDescription: '521' } }] } } };
    const out = normalizeStopTimes(data, '8_x');
    assert.equal(out.arrivals[0].secondsLeft, 0);
    assert.equal(out.arrivals[0].minutesLeft, 0);
});

// --- realtime vs scheduled flag (honest labelling) ---

function at(secondsOffset, opts = {}) {
    const d = new Date(Date.now() + 120000);
    d.setSeconds(secondsOffset, 0); // pin the seconds field exactly
    return { time: d.toISOString(), line: { shortDescription: 'L', codLine: opts.codLine || '9__1__092_' }, codVehicle: opts.codVehicle };
}

test('realtime=false for whole-minute (:00) time with no vehicle (timetable)', () => {
    const out = normalizeStopTimes({ stopTimes: { times: { Time: [at(0)] } } }, '8_x');
    assert.equal(out.arrivals[0].realtime, false);
});

test('realtime=true for sub-minute (:30) prediction', () => {
    const out = normalizeStopTimes({ stopTimes: { times: { Time: [at(30)] } } }, '8_x');
    assert.equal(out.arrivals[0].realtime, true);
});

test('realtime=true when a vehicle code is present even at :00', () => {
    const out = normalizeStopTimes({ stopTimes: { times: { Time: [at(0, { codVehicle: '12345' })] } } }, '8_x');
    assert.equal(out.arrivals[0].realtime, true);
    assert.equal(out.arrivals[0].codVehicle, '12345');
});

// --- NaN guard: an unparseable time must be dropped, not sorted to the front ---

test('normalizeStopTimes drops arrivals with unparseable time', () => {
    const good = new Date(Date.now() + 60000).toISOString();
    const data = {
        stopTimes: { times: { Time: [
            { time: 'not-a-date', line: { shortDescription: 'BAD' } },
            { time: good, line: { shortDescription: 'OK' } },
        ] } },
    };
    const out = normalizeStopTimes(data, '8_x');
    assert.equal(out.arrivals.length, 1);
    assert.equal(out.arrivals[0].line, 'OK');
    assert.ok(Number.isFinite(out.arrivals[0].arrivalEpoch));
});

// --- hasArrival: lines CRTM lists but reports no time for ---

test('lineStatuses marks hasArrival per line', () => {
    const future = new Date(Date.now() + 60000).toISOString();
    const data = {
        stopTimes: {
            times: { Time: [{ time: future, line: { codLine: '8__523___', shortDescription: '523' } }] },
            linesStatus: { LineStatus: [
                { line: { codLine: '8__523___', shortDescription: '523' }, SAEStatus: true },
                { line: { codLine: '9__1__092_', shortDescription: '1' }, SAEStatus: true },
            ] },
        },
    };
    const out = normalizeStopTimes(data, '8_x');
    assert.equal(out.lineStatuses['8__523___'].hasArrival, true);
    assert.equal(out.lineStatuses['9__1__092_'].hasArrival, false);
});
