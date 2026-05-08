'use strict';

// Shared registry of custom Prometheus metrics for the app.
// `fastify-metrics` mounts the default prom-client registry on /metrics,
// so any metric created via `getClient()` ends up exported automatically.

let client = null;
let metrics = null;

function init(promClient) {
    if (metrics) return metrics;
    client = promClient;

    metrics = {
        swrCacheEvents: new client.Counter({
            name: 'swr_cache_events_total',
            help: 'SWR cache events',
            labelNames: ['state'], // fresh|stale|miss|memory|stale_fallback
        }),
        crtmUpstreamErrors: new client.Counter({
            name: 'crtm_upstream_errors_total',
            help: 'Upstream errors when calling CRTM',
            labelNames: ['endpoint', 'status'],
        }),
        crtmUpstreamLatency: new client.Histogram({
            name: 'crtm_upstream_latency_seconds',
            help: 'Latency of CRTM upstream calls',
            labelNames: ['endpoint', 'status'],
            buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8],
        }),
        crtmCircuitState: new client.Gauge({
            name: 'crtm_circuit_state',
            help: 'CRTM circuit-breaker state (0=closed,1=half-open,2=open)',
        }),
        sseConnections: new client.Gauge({
            name: 'sse_connections_active',
            help: 'Active Server-Sent Events connections',
            labelNames: ['stop'],
        }),
        sseConnectionsTotal: new client.Counter({
            name: 'sse_connections_opened_total',
            help: 'Total number of SSE connections opened since start',
        }),
    };
    return metrics;
}

function get() {
    return metrics; // may be null until init() is called
}

function getClient() {
    return client;
}

// Safe wrappers that no-op if metrics aren't initialised yet (eg. in tests).
function inc(name, labels) {
    if (!metrics || !metrics[name]) return;
    if (labels) metrics[name].inc(labels);
    else metrics[name].inc();
}

function set(name, value, labels) {
    if (!metrics || !metrics[name]) return;
    if (labels) metrics[name].set(labels, value);
    else metrics[name].set(value);
}

function observe(name, value, labels) {
    if (!metrics || !metrics[name]) return;
    if (labels) metrics[name].observe(labels, value);
    else metrics[name].observe(value);
}

module.exports = { init, get, getClient, inc, set, observe };
