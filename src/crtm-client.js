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

// One breaker for the whole CRTM upstream — all calls share fate against
// the same backend host, so circuit state is global to the host.
const breaker = new CircuitBreaker({
    name: 'crtm',
    threshold: 5,
    cooldownMs: 15_000,
});

// ---------- Internal helpers ----------

function endpointLabel(path) {
    // Strip query string and keep only the *.php name to keep label cardinality bounded.
    const name = path.split('?')[0].split('/').pop();
    return name || 'unknown';
}

async function crtmFetch(path, retries = MAX_RETRIES) {
    const url = `${CRTM_BASE}${path}`;
    const endpoint = endpointLabel(path);
    let lastErr;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const start = process.hrtime.bigint();
        let statusCode = 0;
        try {
            const result = await breaker.execute(async () => {
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

                if (statusCode === 429) {
                    // Rate-limit: throw so circuit/retry layers see it
                    const text = await res.body.text().catch(() => '');
                    const err = new Error(`CRTM rate-limited (429) on ${endpoint}`);
                    err.statusCode = 429;
                    err.upstream = true;
                    err.body = text.substring(0, 200);
                    throw err;
                }

                if (statusCode < 200 || statusCode >= 300) {
                    const text = await res.body.text().catch(() => '');
                    const err = new Error(`CRTM responded ${statusCode} on ${endpoint}`);
                    err.statusCode = statusCode;
                    err.upstream = true;
                    err.body = text.substring(0, 200);
                    throw err;
                }

                const text = await res.body.text();
                let data;
                try {
                    data = JSON.parse(text);
                } catch {
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
                if (data && data.errorCode && String(data.errorCode) !== '0') {
                    const err = new Error(`CRTM API Error: ${data.errorMessage || data.errorCode}`);
                    err.upstream = true;
                    throw err;
                }
                if (data && data.error) {
                    const err = new Error(`CRTM API Error: ${data.error}`);
                    err.upstream = true;
                    throw err;
                }
                return data;
            });

            const dur = Number(process.hrtime.bigint() - start) / 1e9;
            metrics.observe('crtmUpstreamLatency', dur, { endpoint, status: String(statusCode) });
            return result;
        } catch (err) {
            const dur = Number(process.hrtime.bigint() - start) / 1e9;
            const status = String(err.statusCode || (err.code === 'CIRCUIT_OPEN' ? 'open' : 'err'));
            metrics.observe('crtmUpstreamLatency', dur, { endpoint, status });
            metrics.inc('crtmUpstreamErrors', { endpoint, status });
            lastErr = err;

            // Differentiated logging: structured marker so ops can split
            // "the upstream is broken" from "our handlers blew up".
            logger.get().warn(
                {
                    kind: 'upstream',
                    endpoint,
                    status,
                    attempt: attempt + 1,
                    err: err.message,
                    circuit: breaker.snapshot().state,
                },
                'CRTM upstream error'
            );

            // Don't retry past breaker-open or 429 (already had its own backoff)
            if (err.code === 'CIRCUIT_OPEN') break;

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

function getBreakerSnapshot() {
    return breaker.snapshot();
}

function lineCode(mode, line) {
    return `${mode}__${line}___`;
}

function stopCode(mode, stop) {
    return `${mode}_${stop}`;
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

async function getLinesTimeplanning(codLine) {
    return crtmFetch(
        `/GetLinesTimePlanning.php?activeItinerary=1&codLine=${encodeURIComponent(codLine)}`
    );
}

module.exports = {
    lineCode,
    stopCode,
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
    getLinesTimeplanning,
    getBreakerSnapshot,
};
