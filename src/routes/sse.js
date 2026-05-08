'use strict';

const crtm = require('../crtm-client');
const { swr } = require('../cache');
const config = require('../config');
const metrics = require('../metrics');
const logger = require('../logger');

const HEARTBEAT_MS = config.sse.heartbeatInterval;
const UPDATE_MS = config.sse.updateInterval;

// Active SSE connections tracker
const connections = new Map();

const codStopParams = {
    type: 'object',
    properties: { codStop: { type: 'string', pattern: '^\\d+_\\d+$', maxLength: 20 } },
    required: ['codStop'],
    additionalProperties: false,
};

async function sseRoutes(fastify) {
    // SSE stream for a specific stop
    fastify.get('/api/sse/stop/:codStop', {
        schema: { params: codStopParams },
        // Disable global compression — chunked SSE must not be buffered.
        config: { compress: false },
    }, async (req, reply) => {
        const { codStop } = req.params;
        const connId = `${codStop}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        let eventId = Number(req.headers['last-event-id']) || 0;

        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        });
        reply.raw.flushHeaders();

        // Tell the browser how long to wait before reconnecting after a drop.
        // Combined with reconnecting wrapper on the frontend this gives us a
        // steady cadence even on flaky 4G (artifact §8).
        reply.raw.write('retry: 5000\n\n');

        // Initial snapshot — instant paint
        try {
            const data = await fetchStopTimes(codStop);
            sendEvent(reply.raw, 'update', data, ++eventId);
        } catch (err) {
            sendEvent(reply.raw, 'error', { message: 'Failed to load initial data', codStop }, ++eventId);
            logger.get().warn(
                {
                    kind: err.upstream ? 'upstream' : 'app',
                    component: 'sse',
                    codStop,
                    err: err.message,
                    code: err.code,
                },
                'SSE initial load failed'
            );
        }

        const updateTimer = setInterval(async () => {
            try {
                const data = await fetchStopTimes(codStop);
                sendEvent(reply.raw, 'update', data, ++eventId);
            } catch (err) {
                sendEvent(reply.raw, 'error', { message: 'Update failed', codStop, code: err.code }, ++eventId);
            }
        }, UPDATE_MS);

        const heartbeatTimer = setInterval(() => {
            try {
                reply.raw.write(': heartbeat\n\n');
            } catch {
                cleanup();
            }
        }, HEARTBEAT_MS);

        connections.set(connId, { codStop, reply: reply.raw, updateTimer, heartbeatTimer });
        metrics.set('sseConnections', connections.size, { stop: codStop });
        metrics.inc('sseConnectionsTotal');

        function cleanup() {
            clearInterval(updateTimer);
            clearInterval(heartbeatTimer);
            connections.delete(connId);
            metrics.set('sseConnections', byStopCount(codStop), { stop: codStop });
        }

        req.raw.on('close', cleanup);
        req.raw.on('error', cleanup);

        reply.hijack();
    });

    fastify.get('/api/sse/stats', async () => {
        const groupedByStop = {};
        for (const [, conn] of connections) {
            groupedByStop[conn.codStop] = (groupedByStop[conn.codStop] || 0) + 1;
        }
        return {
            totalConnections: connections.size,
            byStop: groupedByStop,
        };
    });
}

async function fetchStopTimes(codStop) {
    const key = `stops:times:${codStop}`;
    const data = await swr(key, () => crtm.getStopTimes(codStop));
    return normalizeForSSE(data, codStop);
}

function byStopCount(codStop) {
    let n = 0;
    for (const [, c] of connections) if (c.codStop === codStop) n++;
    return n;
}

function normalizeForSSE(data, codStop) {
    if (!data?.stopTimes) {
        return { codStop, arrivals: [], timestamp: Date.now(), type: 'empty' };
    }

    const st = data.stopTimes;
    const now = Date.now();
    const arrivals = [];

    const rawTimes = st.times?.Time;
    if (rawTimes) {
        const times = Array.isArray(rawTimes) ? rawTimes : [rawTimes];
        for (const t of times) {
            const arrivalEpoch = new Date(t.time).getTime();
            const diffMs = Math.max(0, arrivalEpoch - now);
            const secondsLeft = Math.round(diffMs / 1000);
            const minutesLeft = Math.floor(secondsLeft / 60);
            const secs = secondsLeft % 60;
            arrivals.push({
                line: t.line?.shortDescription || '',
                lineCode: t.line?.codLine || '',
                destination: t.destination || '',
                direction: t.direction,
                secondsLeft,
                minutesLeft,
                secs,
                arrivalTime: t.time,
                arrivalEpoch,
                codVehicle: t.codVehicle || null,
                isNight: !!(t.line?.nightService),
                codIssue: t.codIssue || null,
            });
        }
    }

    const lineStatuses = {};
    const rawStatus = st.linesStatus?.LineStatus;
    if (rawStatus) {
        const ls = Array.isArray(rawStatus) ? rawStatus : [rawStatus];
        for (const s of ls) {
            lineStatuses[s.line?.codLine] = {
                saeActive: s.SAEStatus === true,
                lineName: s.line?.shortDescription || '',
            };
        }
    }

    return {
        codStop,
        stopName: st.stop?.name || '',
        arrivals: arrivals.sort((a, b) => a.secondsLeft - b.secondsLeft),
        lineStatuses,
        serverTime: st.actualDate || new Date().toISOString(),
        serverEpoch: now,
        timestamp: now,
        type: 'update',
    };
}

function sendEvent(stream, event, data, id) {
    try {
        if (id !== undefined) stream.write(`id: ${id}\n`);
        stream.write(`event: ${event}\n`);
        stream.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
        // Connection already closed
    }
}

function getConnectionCount() {
    return connections.size;
}

module.exports = sseRoutes;
module.exports.getConnectionCount = getConnectionCount;
module.exports.normalizeForSSE = normalizeForSSE;
