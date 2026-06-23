'use strict';

// Lightweight rolling incident log. One JSONL file per day under LOG_DIR,
// kept 7 days. Only high-signal events (breaker transitions, startup) + a
// 1/min heartbeat are written, so it stays tiny (~1-2 MB/week) yet lets you
// pinpoint "why did ETAs break at HH:MM" after the fact. Appends are async
// and never throw into the request path.
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* noop */ }

function fileFor() {
    return path.join(LOG_DIR, `b4us-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

let lastPrune = 0;
function prune() {
    const now = Date.now();
    if (now - lastPrune < 3600_000) return;
    lastPrune = now;
    try {
        for (const f of fs.readdirSync(LOG_DIR)) {
            const m = f.match(/^b4us-(\d{4}-\d{2}-\d{2})\.jsonl$/);
            if (m && now - new Date(m[1]).getTime() > 7 * 864e5) {
                fs.unlink(path.join(LOG_DIR, f), () => {});
            }
        }
    } catch { /* noop */ }
}

function event(evt, data) {
    let line;
    try { line = JSON.stringify({ t: new Date().toISOString(), evt, ...data }) + '\n'; }
    catch { return; }
    fs.appendFile(fileFor(), line, () => {});
    prune();
}

module.exports = { event, LOG_DIR };
