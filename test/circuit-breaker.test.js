'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CircuitBreaker, STATE } = require('../src/circuit-breaker');

test('starts closed and lets calls through', async () => {
    const cb = new CircuitBreaker({ name: 't1', threshold: 3, cooldownMs: 50 });
    assert.equal(cb.snapshot().state, STATE.CLOSED);
    const r = await cb.execute(async () => 'ok');
    assert.equal(r, 'ok');
});

test('opens after `threshold` consecutive failures', async () => {
    const cb = new CircuitBreaker({ name: 't2', threshold: 3, cooldownMs: 50 });
    for (let i = 0; i < 3; i++) {
        await assert.rejects(cb.execute(async () => { throw new Error('boom'); }));
    }
    assert.equal(cb.snapshot().state, STATE.OPEN);

    // Calls fail fast with CIRCUIT_OPEN while OPEN
    await assert.rejects(
        cb.execute(async () => 'should-not-run'),
        (err) => err.code === 'CIRCUIT_OPEN'
    );
});

test('moves to half-open after cooldown and recloses on success', async () => {
    const cb = new CircuitBreaker({ name: 't3', threshold: 2, cooldownMs: 30 });
    await assert.rejects(cb.execute(async () => { throw new Error('x'); }));
    await assert.rejects(cb.execute(async () => { throw new Error('x'); }));
    assert.equal(cb.snapshot().state, STATE.OPEN);

    await new Promise((r) => setTimeout(r, 40));
    // First call after cooldown is allowed (half-open probe)
    const ok = await cb.execute(async () => 'ok');
    assert.equal(ok, 'ok');
    assert.equal(cb.snapshot().state, STATE.CLOSED);
});

test('half-open failure trips the breaker again', async () => {
    const cb = new CircuitBreaker({ name: 't4', threshold: 2, cooldownMs: 30 });
    for (let i = 0; i < 2; i++) {
        await assert.rejects(cb.execute(async () => { throw new Error('x'); }));
    }
    await new Promise((r) => setTimeout(r, 40));
    // First call after cooldown — fails → goes back to OPEN
    await assert.rejects(cb.execute(async () => { throw new Error('still broken'); }));
    assert.equal(cb.snapshot().state, STATE.OPEN);
});

test('failure counter resets on a successful call', async () => {
    const cb = new CircuitBreaker({ name: 't5', threshold: 5, cooldownMs: 10 });
    await assert.rejects(cb.execute(async () => { throw new Error('x'); }));
    await assert.rejects(cb.execute(async () => { throw new Error('x'); }));
    assert.equal(cb.snapshot().failures, 2);
    await cb.execute(async () => 'ok');
    assert.equal(cb.snapshot().failures, 0);
});
