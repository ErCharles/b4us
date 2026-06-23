'use strict';

const { request } = require('undici');
const config = require('./config');
const metrics = require('./metrics');
const logger = require('./logger');
const { CircuitBreaker } = require('./circuit-breaker');

const CRTM_BASE = config.crtm.baseUrl;
const UA = config.crtm.userAgent;
const TIMEOUT = config.crtm.timeout;
const MAX_RETRIES = config.crtm.retries;

// One breaker PER upstream endpoint (keyed by the *.php name). A flaky
// GetLineLocation must not trip GetStopsTimes — they fail independently.
const breakers = new Map();
function getBreaker(endpoint) {
    let b = breakers.get(endpoint);
    if (!b) {
        b = new CircuitBreaker({ name: `crtm:${endpoint}`, threshold: 5, cooldownMs: 15_000 });
        breakers.set(endpoint, b);
    }
    return b;
}

// Only genuine upstream/transport failures count against the breaker.
const isUpstreamFailure = (err) => err.upstream === true;

// Rolling window of upstream-error timestamps for the heartbeat log.
let _errWin = [];
function recentUpstreamErrors() { const c = Date.now() - 60000; _errWin = _errWin.filter((t) => t > c); return _errWin.length; }

// ---------- Internal helpers ----------

function endpointLabel(path) {
    // Strip query string and keep only the *.php name to keep label cardinality bounded.
    const name = path.split('?')[0].split('/').pop();
    return name || 'unknown';
}

async function crtmFetch(path, retries = MAX_RETRIES) {
    const endpoint = endpointLabel(path);
    const breaker = getBreaker(endpoint);
    // Wrap the WHOLE retry loop in ONE breaker call: a single logical fetch
    // is one breaker event, so a request with retries=2 can't rack up 3
    // failures and open the circuit by itself. The breaker fast-fails
    // (CIRCUIT_OPEN) before we ever enter the loop when it's open.
    return breaker.execute(() => doFetch(`${CRTM_BASE}${path}`, endpoint, retries), isUpstreamFailure);
}

async function doFetch(url, endpoint, retries) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const start = process.hrtime.bigint();
        let statusCode = 0;
        try {
            const res = await request(url, {
                method: 'GET',
                headers: {
                    'User-Agent': UA,
                    Accept: 'application/json, text/plain, */*',
                    'Accept-Language': 'es-ES,es;q=0.9',
                    Referer: 'https://www.crtm.es/',
                    Origin: 'https://www.crtm.es',
                },
                headersTimeout: TIMEOUT,
                bodyTimeout: TIMEOUT,
            });
            statusCode = res.statusCode;
            const text = await res.body.text();

            // 429 = rate limit: always upstream (drives backoff + breaker).
            if (statusCode === 429) {
                const err = new Error(`CRTM rate-limited (429) on ${endpoint}`);
                err.statusCode = 429;
                err.upstream = true;
                err.body = text.substring(0, 200);
                throw err;
            }

            let data = null;
            let parsed = false;
            try { data = JSON.parse(text); parsed = true; } catch { /* not JSON */ }

            // Application-level error envelope (e.g. a non-existent stop). CRTM's
            // WCF backend returns these even with a 5xx status, but it clearly
            // PROCESSED the request — it just has nothing. Treat as "no data":
            // return the body (normalizers yield empty) WITHOUT throwing, so a
            // typo/bot can't open the breaker or 502-spam. A genuine outage
            // (connection error, or 5xx with no JSON envelope) still throws below.
            if (parsed && data && (data.error || (data.errorCode && String(data.errorCode) !== '0'))) {
                logger.get().warn(
                    { kind: 'upstream', endpoint, status: String(statusCode), apiError: data.errorMessage || data.message || data.error || data.errorCode },
                    'CRTM application-level response (returned as empty)'
                );
                const dur = Number(process.hrtime.bigint() - start) / 1e9;
                metrics.observe('crtmUpstreamLatency', dur, { endpoint, status: 'apierr' });
                return data;
            }

            // Genuine transport/server failure → upstream (breaker counts).
            if (statusCode < 200 || statusCode >= 300) {
                const err = new Error(`CRTM responded ${statusCode} on ${endpoint}`);
                err.statusCode = statusCode;
                err.upstream = true;
                err.body = text.substring(0, 200);
                throw err;
            }
            // 2xx but unparseable, or a SOAP-style server fault → upstream.
            if (!parsed) {
                const err = new Error(`Invalid JSON from CRTM on ${endpoint}`);
                err.upstream = true;
                err.body = text.substring(0, 200);
                throw err;
            }
            if (data && (data.faultcode || data.faultstring)) {
                const err = new Error(`CRTM Fault: ${data.faultstring || data.faultcode}`);
                err.upstream = true;
                throw err;
            }

            const dur = Number(process.hrtime.bigint() - start) / 1e9;
            metrics.observe('crtmUpstreamLatency', dur, { endpoint, status: String(statusCode) });
            return data;
        } catch (err) {
            const dur = Number(process.hrtime.bigint() - start) / 1e9;
            const status = String(err.statusCode || 'err');
            metrics.observe('crtmUpstreamLatency', dur, { endpoint, status });
            metrics.inc('crtmUpstreamErrors', { endpoint, status });
            _errWin.push(Date.now());
            lastErr = err;

            logger.get().warn(
                { kind: 'upstream', endpoint, status, attempt: attempt + 1, err: err.message },
                'CRTM upstream error'
            );

            if (err.statusCode === 429) {
                const wait = Math.min(1000 * 2 ** attempt, 5000);
                await new Promise((r) => setTimeout(r, wait));
            } else if (attempt < retries) {
                await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            }
        }
    }

    throw lastErr;
}

// Aggregate snapshot across all per-endpoint breakers for /health.
function getBreakerSnapshot() {
    let state = 0;
    let failures = 0;
    let openedAt = 0;
    const byEndpoint = {};
    for (const [, b] of breakers) {
        const s = b.snapshot();
        byEndpoint[s.name] = s.state;
        if (s.state > state) state = s.state;
        failures += s.failures;
        if (s.openedAt && s.openedAt > openedAt) openedAt = s.openedAt;
    }
    return { state, failures, openedAt: openedAt || null, byEndpoint };
}

// ---------- Stops ----------

async function getStopInfo(codStop) {
    return crtmFetch(`/GetStops.php?codStop=${encodeURIComponent(codStop)}`);
}

async function searchStops(query) {
    return crtmFetch(`/GetStops.php?customSearch=${encodeURIComponent(query)}`);
}

async function getStopsByMunicipality(codMunicipality) {
    return crtmFetch(
        `/GetStops.php?codMunicipality=${encodeURIComponent(codMunicipality)}`
    );
}

async function getStopsByPostCode(postcode) {
    return crtmFetch(
        `/GetStops.php?postcode=${encodeURIComponent(postcode)}`
    );
}

async function getNearestStops(lat, lng, distance, method = 2) {
    return crtmFetch(
        `/GetNearestStopsByLocation.php?latitude=${lat}&longitude=${lng}&mode=&method=${method}&precision=${distance}`
    );
}

async function getStopTimes(codStop, stopType = 0, stopTimesByIti = '', orderBy = 2) {
    const iti = stopTimesByIti || codStop;
    return crtmFetch(
        `/GetStopsTimes.php?codStop=${encodeURIComponent(codStop)}&type=${stopType}&orderBy=${orderBy}&stopTimesByIti=${encodeURIComponent(iti)}`
    );
}

// ---------- Lines ----------

async function getLinesByMode(modeCod) {
    return crtmFetch(`/GetLines.php?mode=${modeCod}`);
}

async function getLinesByMunicipality(codMunicipality, codMode) {
    let url = `/GetLines.php?codMunicipality=${codMunicipality}`;
    if (codMode) url += `&mode=${codMode}`;
    return crtmFetch(url);
}

async function getLineInfo(codLine) {
    return crtmFetch(
        `/GetLinesInformation.php?activeItinerary=1&codLine=${encodeURIComponent(codLine)}`
    );
}

async function getLineLocation(modeCod, codItinerary, codLine, codStop, direction) {
    return crtmFetch(
        `/GetLineLocation.php?mode=${modeCod}&codItinerary=${encodeURIComponent(codItinerary)}&codLine=${encodeURIComponent(codLine)}&codStop=${encodeURIComponent(codStop)}&direction=${direction}`
    );
}

async function getIncidents(modeCod, codLine) {
    return crtmFetch(
        `/GetIncidentsAffectations.php?mode=${modeCod}&codLine=${encodeURIComponent(codLine)}`
    );
}

module.exports = {
    getStopInfo,
    searchStops,
    getStopsByMunicipality,
    getStopsByPostCode,
    getNearestStops,
    getStopTimes,
    getLinesByMode,
    getLinesByMunicipality,
    getLineInfo,
    getLineLocation,
    getIncidents,
    getBreakerSnapshot,
    recentUpstreamErrors,
};
