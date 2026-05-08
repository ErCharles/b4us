'use strict';

// B4us — minimal service worker.
// - Pre-caches the app shell so the UI loads instantly offline.
// - Network-first with cache fallback for stable APIs (lines/info, stops/info).
// - Bypasses /api/sse/* and /api/stops/<id>/times (must always be live).
//
// SCOPE: paths are computed from `self.location` so the SW works whether the
// app is served at the origin root (bus.carloscyberseces.com/) or under a
// project subpath (carlituus16.github.io/BUS/). API calls on .github.io go
// to a different origin (cross-origin) so they bypass this SW automatically.

const VERSION = 'v1.5.1';
const SHELL_CACHE = `bt-shell-${VERSION}`;
const RUNTIME_CACHE = `bt-runtime-${VERSION}`;
const SCOPE_PATH = new URL('./', self.location).pathname;

const SHELL = [
    SCOPE_PATH,
    SCOPE_PATH + 'index.css',
    SCOPE_PATH + 'app.js',
    SCOPE_PATH + 'manifest.webmanifest',
    SCOPE_PATH + 'icons/icon-192.svg',
    SCOPE_PATH + 'icons/icon-512.svg',
    SCOPE_PATH + 'madrid-stops.json',
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
                    .map((k) => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

function isLiveAPI(url) {
    // ETAs and SSE must always go to the network.
    if (url.pathname.startsWith('/api/sse/')) return true;
    if (/^\/api\/stops\/[^/]+\/times$/.test(url.pathname)) return true;
    if (/^\/api\/lines\/[^/]+\/location$/.test(url.pathname)) return true;
    return false;
}

function isStableAPI(url) {
    // Info-style endpoints — fine to serve from cache during a network blip.
    if (/^\/api\/stops\/(municipality|postcode|search|nearby)/.test(url.pathname)) return true;
    if (/^\/api\/stops\/[^/]+$/.test(url.pathname)) return true;
    if (/^\/api\/lines/.test(url.pathname)) return true;
    return false;
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    if (isLiveAPI(url)) return; // pass-through

    // Deep link routes <scope>/stop/:codStop are SPA — serve cached shell index.
    if (url.pathname.startsWith(SCOPE_PATH + 'stop/')) {
        event.respondWith(
            caches.match(SCOPE_PATH).then((c) => c || fetch(SCOPE_PATH))
        );
        return;
    }

    if (isStableAPI(url)) {
        event.respondWith(networkFirst(req));
        return;
    }

    // Default: shell — cache-first then network, populate runtime cache opportunistically.
    event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
        const res = await fetch(req);
        if (res && res.status === 200 && res.type === 'basic') {
            const c = await caches.open(RUNTIME_CACHE);
            c.put(req, res.clone());
        }
        return res;
    } catch (err) {
        // Last resort: serve the shell so the SPA still loads.
        const fallback = await caches.match(SCOPE_PATH);
        if (fallback) return fallback;
        throw err;
    }
}

async function networkFirst(req) {
    try {
        const res = await fetch(req);
        if (res && res.status === 200) {
            const c = await caches.open(RUNTIME_CACHE);
            c.put(req, res.clone());
        }
        return res;
    } catch (err) {
        const cached = await caches.match(req);
        if (cached) return cached;
        throw err;
    }
}

// Handle messages from the page (e.g. ask SW to skip waiting).
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
