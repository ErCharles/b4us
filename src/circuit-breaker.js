'use strict';

const metrics = require('./metrics');

const STATE = Object.freeze({ CLOSED: 0, HALF_OPEN: 1, OPEN: 2 });

/**
 * Minimal consecutive-failure circuit breaker.
 *
 * - CLOSED: calls flow normally; `threshold` consecutive failures → OPEN.
 * - OPEN: calls fail fast with a CircuitOpenError until `cooldownMs` elapses, then HALF_OPEN.
 * - HALF_OPEN: a single probe is allowed; success → CLOSED, failure → OPEN.
 *
 * Designed to wrap the CRTM upstream so a sustained outage doesn't
 * burn request capacity hammering a known-broken endpoint.
 */
class CircuitBreaker {
    constructor({ name = 'default', threshold = 5, cooldownMs = 15_000, halfOpenLimit = 1 } = {}) {
        this.name = name;
        this.threshold = threshold;
        this.cooldownMs = cooldownMs;
        this.halfOpenLimit = halfOpenLimit;
        this.state = STATE.CLOSED;
        this.failures = 0;
        this.openedAt = 0;
        this.halfOpenInflight = 0;
        this._reportState();
    }

    canExecute() {
        if (this.state === STATE.CLOSED) return true;
        if (this.state === STATE.OPEN) {
            if (Date.now() - this.openedAt >= this.cooldownMs) {
                this.state = STATE.HALF_OPEN;
                this.halfOpenInflight = 0;
                this._reportState();
                return true; // allow first probe
            }
            return false;
        }
        // HALF_OPEN: only allow halfOpenLimit concurrent probes. Extra
        // requests fail fast so a slow upstream can't pile inflight calls.
        return this.halfOpenInflight < this.halfOpenLimit;
    }

    recordSuccess() {
        if (this.state !== STATE.CLOSED) {
            this.state = STATE.CLOSED;
            this._reportState();
        }
        this.failures = 0;
    }

    recordFailure() {
        this.failures += 1;
        if (this.state === STATE.HALF_OPEN || this.failures >= this.threshold) {
            this.state = STATE.OPEN;
            this.openedAt = Date.now();
            this._reportState();
        }
    }

    // `isFailure(err)` decides whether a thrown error counts against the
    // breaker. Default: everything counts. Callers wrapping an upstream pass
    // a classifier so that *client/API* errors (e.g. a non-existent stop)
    // don't open the circuit — the upstream answered, it just said "no".
    // Such errors call recordSuccess() (connectivity proven) before rethrow.
    async execute(fn, isFailure = () => true) {
        if (!this.canExecute()) {
            const err = new Error(`Circuit breaker '${this.name}' is OPEN`);
            err.code = 'CIRCUIT_OPEN';
            throw err;
        }
        const wasHalfOpen = this.state === STATE.HALF_OPEN;
        if (wasHalfOpen) this.halfOpenInflight += 1;
        try {
            const result = await fn();
            this.recordSuccess();
            return result;
        } catch (err) {
            if (isFailure(err)) this.recordFailure();
            else this.recordSuccess();
            throw err;
        } finally {
            if (wasHalfOpen) this.halfOpenInflight -= 1;
        }
    }

    snapshot() {
        return {
            name: this.name,
            state: this.state,
            failures: this.failures,
            openedAt: this.openedAt || null,
        };
    }

    _reportState() {
        metrics.set('crtmCircuitState', this.state, { name: this.name });
    }
}

module.exports = { CircuitBreaker, STATE };
