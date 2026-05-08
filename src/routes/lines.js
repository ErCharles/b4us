'use strict';

const crtm = require('../crtm-client');
const { swr } = require('../cache');

const codLineSchema = {
    type: 'object',
    properties: {
        codLine: { type: 'string', pattern: '^[\\w\\-]{1,30}$' },
    },
    required: ['codLine'],
    additionalProperties: false,
};

const STABLE_CACHE = 'public, max-age=600, stale-while-revalidate=86400, stale-if-error=600';
const VOLATILE_CACHE = 'no-store';

async function linesRoutes(fastify) {
    // Get all lines by mode (default: interurbano = 8)
    fastify.get('/api/lines', {
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    mode: { type: 'integer', minimum: 1, maximum: 99, default: 8 },
                    municipality: { type: 'string', pattern: '^\\d{1,6}$' },
                },
                additionalProperties: false,
            },
        },
    }, async (req, reply) => {
        const { mode, municipality } = req.query;
        reply.header('Cache-Control', STABLE_CACHE);

        if (municipality) {
            const key = `lines:muni:${municipality}:${mode}`;
            const data = await swr(key, () =>
                crtm.getLinesByMunicipality(municipality, mode)
            );
            return { lines: normalizeLines(data), mode, municipality };
        }

        const key = `lines:mode:${mode}`;
        const data = await swr(key, () => crtm.getLinesByMode(mode));
        return { lines: normalizeLines(data), mode };
    });

    // Get detailed line info
    fastify.get('/api/lines/:codLine', {
        schema: { params: codLineSchema },
    }, async (req, reply) => {
        const { codLine } = req.params;
        const key = `lines:info:${codLine}`;
        const data = await swr(key, () => crtm.getLineInfo(codLine));
        reply.header('Cache-Control', STABLE_CACHE);
        return data;
    });

    // Get line vehicle locations (live → no edge cache)
    fastify.get('/api/lines/:codLine/location', {
        schema: {
            params: codLineSchema,
            querystring: {
                type: 'object',
                required: ['mode', 'itinerary', 'stop', 'direction'],
                properties: {
                    mode: { type: 'integer', minimum: 1, maximum: 99 },
                    itinerary: { type: 'string', maxLength: 60 },
                    stop: { type: 'string', maxLength: 30 },
                    direction: { type: 'integer', minimum: 1, maximum: 2 },
                },
                additionalProperties: false,
            },
        },
    }, async (req, reply) => {
        const { codLine } = req.params;
        const { mode, itinerary, stop, direction } = req.query;
        const key = `lines:loc:${codLine}:${direction}`;
        const data = await swr(key, () =>
            crtm.getLineLocation(mode, itinerary, codLine, stop, direction)
        );
        reply.header('Cache-Control', VOLATILE_CACHE);
        return data;
    });

    // Get incidents for a line
    fastify.get('/api/lines/:codLine/incidents', {
        schema: {
            params: codLineSchema,
            querystring: {
                type: 'object',
                properties: {
                    mode: { type: 'integer', minimum: 1, maximum: 99, default: 8 },
                },
                additionalProperties: false,
            },
        },
    }, async (req, reply) => {
        const { codLine } = req.params;
        const mode = req.query.mode || 8;
        const key = `lines:incidents:${codLine}`;
        const data = await swr(key, () => crtm.getIncidents(mode, codLine));
        reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
        return data;
    });

    // Get line time planning
    fastify.get('/api/lines/:codLine/timeplanning', {
        schema: { params: codLineSchema },
    }, async (req, reply) => {
        const { codLine } = req.params;
        const key = `lines:tp:${codLine}`;
        const data = await swr(key, () => crtm.getLinesTimeplanning(codLine));
        reply.header('Cache-Control', STABLE_CACHE);
        return data;
    });
}

function normalizeLines(data) {
    if (!data?.lines?.Line) return [];
    const raw = data.lines.Line;
    return Array.isArray(raw) ? raw : [raw];
}

module.exports = linesRoutes;
module.exports.normalizeLines = normalizeLines;
