'use strict';

const crtm = require('../crtm-client');
const { swr } = require('../cache');
const config = require('../config');

// Live ETA endpoints poll frequently; use a short fresh window (so each poll
// gets near-live data) and a short negative window (so a 1s CRTM blip doesn't
// freeze a stop for the default 30s).
const LIVE_OPTS = { freshTtl: config.cache.liveFreshTtl, negativeTtl: config.cache.liveNegativeTtl };

// ---------- Reusable schema fragments ----------

const codStopSchema = {
    type: 'object',
    properties: { codStop: { type: 'string', pattern: '^\\d+_\\d+$', maxLength: 20 } },
    required: ['codStop'],
    additionalProperties: false,
};

const postcodeSchema = {
    type: 'object',
    properties: { postcode: { type: 'string', pattern: '^\\d{5}$' } },
    required: ['postcode'],
    additionalProperties: false,
};

const muniSchema = {
    type: 'object',
    properties: { codMunicipality: { type: 'string', pattern: '^\\d{1,6}$' } },
    required: ['codMunicipality'],
    additionalProperties: false,
};

const STABLE_CACHE = 'public, max-age=300, stale-while-revalidate=86400, stale-if-error=600';

async function stopsRoutes(fastify) {
    // Search stops by name
    fastify.get('/api/stops/search', {
        schema: {
            querystring: {
                type: 'object',
                required: ['q'],
                properties: { q: { type: 'string', minLength: 2, maxLength: 80 } },
                additionalProperties: false,
            },
        },
    }, async (req, reply) => {
        const { q } = req.query;
        const key = `stops:search:${q.toLowerCase().trim()}`;
        const data = await swr(key, () => crtm.searchStops(q));
        const stops = normalizeStops(data);
        reply.header('Cache-Control', STABLE_CACHE);
        return { stops, query: q, count: stops.length };
    });

    // Get stop info
    fastify.get('/api/stops/:codStop', {
        schema: { params: codStopSchema },
    }, async (req, reply) => {
        const { codStop } = req.params;
        const key = `stops:info:${codStop}`;
        const data = await swr(key, () => crtm.getStopInfo(codStop));
        reply.header('Cache-Control', STABLE_CACHE);
        return data;
    });

    // ETA arrivals (core endpoint — never cached at edge)
    fastify.get('/api/stops/:codStop/times', {
        schema: { params: codStopSchema },
    }, async (req, reply) => {
        const { codStop } = req.params;
        const key = `stops:times:${codStop}`;
        const data = await swr(key, () => crtm.getStopTimes(codStop), LIVE_OPTS);
        reply.header('Cache-Control', 'no-store');
        return normalizeStopTimes(data, codStop);
    });

    // Nearest stops by geolocation
    fastify.get('/api/stops/nearby', {
        schema: {
            querystring: {
                type: 'object',
                required: ['lat', 'lng'],
                properties: {
                    lat: { type: 'number', minimum: -90, maximum: 90 },
                    lng: { type: 'number', minimum: -180, maximum: 180 },
                    radius: { type: 'number', minimum: 50, maximum: 5000, default: 500 },
                },
                additionalProperties: false,
            },
        },
    }, async (req, reply) => {
        const { lat, lng, radius } = req.query;
        const key = `stops:nearby:${lat.toFixed(4)}_${lng.toFixed(4)}_${radius}`;
        const data = await swr(key, () => crtm.getNearestStops(lat, lng, radius || 500));
        const stops = normalizeStops(data);
        reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
        return { stops, lat, lng, radius, count: stops.length };
    });

    // All stops by municipality
    fastify.get('/api/stops/municipality/:codMunicipality', {
        schema: { params: muniSchema },
    }, async (req, reply) => {
        const { codMunicipality } = req.params;
        const key = `stops:muni:${codMunicipality}`;
        const data = await swr(key, () => crtm.getStopsByMunicipality(codMunicipality));
        const stops = normalizeStops(data);
        reply.header('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
        return { stops, codMunicipality, count: stops.length };
    });

    // Stops by postal code
    fastify.get('/api/stops/postcode/:postcode', {
        schema: { params: postcodeSchema },
    }, async (req, reply) => {
        const { postcode } = req.params;
        const key = `stops:postcode:${postcode}`;
        const data = await swr(key, () => crtm.getStopsByPostCode(postcode));
        const stops = normalizeStops(data);
        reply.header('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
        return { stops, postcode, count: stops.length };
    });
}

// ---------- Normalizers ----------

function normalizeStops(data) {
    if (!data?.stops?.Stop) return [];
    const raw = data.stops.Stop;
    return Array.isArray(raw) ? raw : [raw];
}

// Single source of truth for the stop-times payload, shared by the HTTP
// endpoint and the SSE stream (which only adds `type:'update'`).
function normalizeStopTimes(data, codStop) {
    const now = Date.now();
    if (!data?.stopTimes) {
        return { codStop, stopName: '', arrivals: [], lineStatuses: {}, serverEpoch: now, timestamp: now };
    }

    const st = data.stopTimes;
    const arrivals = [];

    const rawTimes = st.times?.Time;
    if (rawTimes) {
        const times = Array.isArray(rawTimes) ? rawTimes : [rawTimes];
        for (const t of times) {
            const arrivalDate = new Date(t.time);
            const arrivalEpoch = arrivalDate.getTime();
            // NaN guard: an unparseable `time` would sort to the FRONT of the
            // list and break the countdown. Drop it instead.
            if (!Number.isFinite(arrivalEpoch)) continue;
            const secondsLeft = Math.max(0, Math.round((arrivalEpoch - now) / 1000));
            const codVehicle = (t.codVehicle && String(t.codVehicle).trim()) || null;
            // CRTM live (SAE/GPS) predictions land on arbitrary seconds; pure
            // timetable entries sit exactly on the whole minute (:00). So a
            // vehicle code OR sub-minute precision ⇒ real-time; :00 + no
            // vehicle ⇒ scheduled. Don't paint scheduled times as "live".
            const realtime = Boolean(codVehicle) || arrivalDate.getSeconds() !== 0;
            arrivals.push({
                line: t.line?.shortDescription || '',
                lineCode: t.line?.codLine || '',
                lineName: t.line?.description || '',
                destination: t.destination || '',
                direction: t.direction,
                secondsLeft,
                minutesLeft: Math.floor(secondsLeft / 60),
                secs: secondsLeft % 60,
                arrivalTime: t.time,
                arrivalEpoch,
                codVehicle,
                isNight: !!(t.line?.nightService),
                codIssue: t.codIssue || null,
                realtime,
                color: lineColorMap[t.line?.shortDescription] || '#8EBF42',
                company: t.line?.company || '',
            });
        }
    }
    arrivals.sort((a, b) => a.secondsLeft - b.secondsLeft);

    // Line statuses. `hasArrival` lets the UI honestly show lines that CRTM
    // associates with this stop but reports no time for ("sin tiempo real").
    const statuses = {};
    const rawStatus = st.linesStatus?.LineStatus;
    if (rawStatus) {
        const ls = Array.isArray(rawStatus) ? rawStatus : [rawStatus];
        const withArrival = new Set(arrivals.map((a) => a.lineCode));
        for (const s of ls) {
            const code = s.line?.codLine;
            statuses[code] = {
                saeActive: s.SAEStatus === true,
                lineName: s.line?.shortDescription || '',
                hasArrival: withArrival.has(code),
            };
        }
    }

    return {
        codStop,
        stopName: st.stop?.name || '',
        arrivals,
        lineStatuses: statuses,
        serverTime: st.actualDate || new Date().toISOString(),
        serverEpoch: now,
        timestamp: now,
    };
}

// Common Madrid interurbano line colors
const lineColorMap = {
    '521': '#8EBF42', '522': '#E74C3C', '523': '#3498DB', '524': '#F39C12',
    '525': '#9B59B6', '526': '#1ABC9C', '527': '#E67E22', '528': '#2ECC71',
    '529': '#E91E63', '510': '#00BCD4', '518': '#FF5722', '520': '#795548',
    '551': '#607D8B', '581': '#4CAF50', '528A': '#CDDC39',
    '1': '#FF6B6B', '2': '#4ECDC4', '3': '#45B7D1', '4': '#96CEB4',
    '5': '#FFEAA7', 'N501': '#6366F1', 'N504': '#7C3AED',
};

module.exports = stopsRoutes;
module.exports.normalizeStopTimes = normalizeStopTimes;
module.exports.normalizeStops = normalizeStops;
