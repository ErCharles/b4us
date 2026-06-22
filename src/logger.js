'use strict';

// Shared logger shim. server.js calls set() with the Fastify (Pino) logger
// during boot; before that — and in tests — calls fall back to console.
//
// All structured logs from the CRTM client / cache layer should pass
// `kind: 'upstream'` or `kind: 'app'` so Loki / Grafana queries can split
// "upstream is broken" from "we have a bug" cleanly (artifact §7).

let log = {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
};

function set(l) {
    if (l) log = l;
}

function get() {
    return log;
}

module.exports = { set, get };
