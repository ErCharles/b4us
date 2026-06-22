'use strict';

/* ============================================
   B4us — Mobile-First Application (v1.1)
   ============================================ */

// Deploy-aware bases.
//
// The frontend can be served from two places:
//   1. b4us.pigeon-cobia.ts.net                  (full backend on this host, via Caddy)
//   2. ercharles.github.io/b4us/         (GitHub Pages — frontend only,
//                                        backend lives at #1 via CORS)
//
// API_BASE is empty when frontend and backend share the origin (case 1).
// When deployed to GitHub Pages it points at the API origin so /api/* and
// SSE land on the right server. BASE_PATH covers GH Pages' subpath so
// SPA routes like /stop/:cod and asset URLs resolve correctly.
const _isPages = location.hostname.endsWith('.github.io');
const API_BASE = _isPages ? 'https://b4us.pigeon-cobia.ts.net' : '';
const BASE_PATH = (() => {
    if (!_isPages) return '/';
    const seg = location.pathname.split('/').filter(Boolean)[0] || '';
    return seg ? `/${seg}/` : '/';
})();

// 404.html on GH Pages forwards deep links here as ?p=stop/<cod>. Reconstruct
// the canonical pathname before routing so the share/back/popstate flow stays
// consistent.
(function unwrapDeepLink() {
    const params = new URLSearchParams(location.search);
    const p = params.get('p');
    if (!p) return;
    params.delete('p');
    const qs = params.toString();
    const next = BASE_PATH + p + (qs ? '?' + qs : '') + location.hash;
    history.replaceState({}, '', next);
})();

const PREF_KEY = 'bus_prefs_v1';
const FAV_KEY = 'bus_favs';
const DEFAULT_PREFS = {
    vibrate: true,
    sound: false,
    autoRefresh: true,
};

const state = {
    currentStop: null,
    eventSource: null,
    eventSourceUrl: null,
    eventSourceRetryAt: null,
    eventSourceBackoffMs: 1000,
    eventSourceTimer: null,
    lastEventId: 0,
    favorites: JSON.parse(localStorage.getItem(FAV_KEY) || '[]'),
    prefs: Object.assign({}, DEFAULT_PREFS, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')),
    allStops: [],            // full Madrid dataset (~11k tuples)
    markers: [],             // currently-rendered Leaflet markers
    markersByCode: new Map(),
    countdownTimer: null,
    favTickTimer: null,
    favPollTimer: null,
    serverTimeDelta: 0,
    mapExpanded: false,
    lastEpochs: {},
    lineStatuses: {},
    notifiedKeys: new Set(),       // keys we've already vibrated for in this minute
    audioCtx: null,
    deferredInstall: null,
};

// --- DOM ---
const $ = (s) => document.querySelector(s);
const searchInput = $('#search-input');
const searchClear = $('#search-clear');
const searchResults = $('#search-results');
const favSection = $('#favorites-section');
const favList = $('#favorites-list');
const favEmpty = $('#favorites-empty');
const etaPanel = $('#eta-panel');
const arrivalsList = $('#arrivals-list');
const etaEmpty = $('#eta-empty');
const etaStopName = $('#eta-stop-name');
const etaStopCode = $('#eta-stop-code');
const etaUpdated = $('#eta-updated');
const btnFav = $('#btn-fav');
const btnShare = $('#btn-share');
const btnBack = $('#eta-back');
const btnNearby = $('#btn-nearby');
const btnMenu = $('#btn-menu');
const btnExpandMap = $('#btn-expand-map');
const btnInstall = $('#btn-install');
const btnTheme = $('#btn-theme');
const btnPrefs = $('#favs-toggle-prefs');
const connDot = $('#conn-dot');
const connText = $('#conn-text');
const incidentBanner = $('#incident-banner');
const incidentClose = $('#incident-close');
const updateBanner = $('#update-banner');
const updateReload = $('#update-reload');
const mapContainer = $('#map-container');
const prefsSheet = $('#prefs-sheet');
const prefsClose = $('#prefs-close');
const prefVibrate = $('#pref-vibrate');
const prefSound = $('#pref-sound');
const prefAutoRefresh = $('#pref-auto-refresh');

// --- Colors ---
const COLORS = {
    '521': '#8EBF42', '522': '#E74C3C', '523': '#3498DB', '524': '#F39C12',
    '525': '#9B59B6', '526': '#1ABC9C', '527': '#E67E22', '528': '#2ECC71',
    '529': '#E91E63', '510': '#00BCD4', '518': '#FF5722', '520': '#795548',
    '551': '#607D8B', '581': '#4CAF50', 'N504': '#7C3AED', 'N501': '#6366F1',
    '1': '#FF6B6B', '2': '#4ECDC4', '3': '#45B7D1', '4': '#96CEB4',
    '5': '#FFEAA7', '6': '#DDA0DD', '7': '#87CEEB',
};
function lineColor(l) { return COLORS[l] || '#8EBF42'; }

// --- Map ---
let map = null;
const isDesktop = window.innerWidth > 768;

// Madrid centro (Sol). Used as initial map view AND as a sanity bounding
// box when fitting markers — we don't auto-fit to stops outside the metro
// area to keep zoom sensible if a search returns a far-away result.
const MADRID_CENTER = [40.4168, -3.7038];
const MADRID_BBOX = { minLat: 40.20, maxLat: 40.60, minLng: -4.00, maxLng: -3.50 };

let panSearchTimer = null;
let suppressPanSearch = false; // set true when we move the map programmatically

// --- Lazy-loaded Leaflet ---
// Leaflet's CSS + JS (~150KB) only matter when there's a map to show.
// Inject them on first use and cache the load promise so we never fetch
// twice. `ensureMap()` resolves once `map` (and the global `L`) are ready.
const LEAFLET_VER = '1.9.4';
let _leafletPromise = null;
function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (_leafletPromise) return _leafletPromise;
    _leafletPromise = new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `https://unpkg.com/leaflet@${LEAFLET_VER}/dist/leaflet.css`;
        link.crossOrigin = '';
        document.head.appendChild(link);

        const script = document.createElement('script');
        script.src = `https://unpkg.com/leaflet@${LEAFLET_VER}/dist/leaflet.js`;
        script.crossOrigin = '';
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => { _leafletPromise = null; reject(new Error('Leaflet failed to load')); };
        document.head.appendChild(script);
    });
    return _leafletPromise;
}

let _mapPromise = null;
// Resolves once the Leaflet map is initialized. Safe to call repeatedly.
function ensureMap() {
    if (!isDesktop) return Promise.resolve(null);
    if (map) return Promise.resolve(map);
    if (_mapPromise) return _mapPromise;
    _mapPromise = loadLeaflet().then(() => {
        if (map) return map; // raced
        map = L.map('map', { center: MADRID_CENTER, zoom: 12, zoomControl: false });
        L.control.zoom({ position: 'bottomright' }).addTo(map);
        // Pick the tile theme based on the stored preference / OS preference.
        const wantLight = (() => {
            const t = localStorage.getItem('bus_theme_v1') || 'auto';
            if (t === 'light') return true;
            if (t === 'dark') return false;
            return matchMedia('(prefers-color-scheme: light)').matches;
        })();
        const tileUrl = wantLight
            ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
            : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
        const tileLayer = L.tileLayer(tileUrl, {
            attribution: '&copy; CARTO &copy; OSM',
            maxZoom: 19, subdomains: 'abcd',
        }).addTo(map);
        // Expose for theme switching + ad-hoc inspection (devtools / tests).
        window.__bus = { map, tileLayer, get state() { return state; }, searchAtMapCenter, renderViewport };

        // Re-render markers in viewport on every move/zoom (debounced so dragging
        // is smooth). The full Madrid dataset (~11k stops) lives in `state.allStops`
        // — we render only the subset visible at the current zoom level.
        map.on('moveend', () => {
            if (suppressPanSearch) { suppressPanSearch = false; return; }
            clearTimeout(panSearchTimer);
            panSearchTimer = setTimeout(() => renderViewport(), 200);
        });
        map.on('zoomend', () => {
            clearTimeout(panSearchTimer);
            panSearchTimer = setTimeout(() => renderViewport(), 100);
        });

        // Popup "Ver tiempos" buttons are wired via delegation on popupopen
        // (no inline onclick / window._sel).
        map.on('popupopen', (e) => {
            const root = e.popup.getElement();
            if (!root) return;
            const btn = root.querySelector('.popup-select');
            if (!btn) return;
            btn.addEventListener('click', () => {
                map.closePopup();
                selectStop(btn.dataset.cod, btn.dataset.name, +btn.dataset.lat || null, +btn.dataset.lng || null);
            }, { once: true });
        });

        return map;
    });
    return _mapPromise;
}

function isInMadrid(lat, lng) {
    return lat >= MADRID_BBOX.minLat && lat <= MADRID_BBOX.maxLat
        && lng >= MADRID_BBOX.minLng && lng <= MADRID_BBOX.maxLng;
}

async function searchAtMapCenter() {
    if (!map) return;
    const c = map.getCenter();
    const zoom = map.getZoom();
    // Larger radius when zoomed out — keeps results meaningful at any scale.
    const radius = Math.min(2000, Math.max(300, Math.round(50000 / Math.pow(2, zoom - 12))));
    try {
        const r = await fetch(`${API_BASE}/api/stops/nearby?lat=${c.lat.toFixed(5)}&lng=${c.lng.toFixed(5)}&radius=${radius}`);
        if (!r.ok) {
            if (r.status === 502 || r.status === 503) showUpstreamBanner();
            return;
        }
        const d = await r.json();
        const stops = (d.stops || []).filter(s => String(s.codMode) === '8');
        clearMarkers();
        stops.forEach(addMarker);
        // Don't fitBounds here — that'd make the map jump while the user is panning.
    } catch (e) { console.warn('panSearch:', e.message); }
}

// --- Search ---
let searchTimer;
searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    searchClear.classList.toggle('hidden', !q);
    clearTimeout(searchTimer);
    if (q.length < 2) { hideResults(); return; }
    // Local filtering is cheap, so a minimal debounce just coalesces fast typing.
    searchTimer = setTimeout(() => doSearch(q), 120);
});

searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.classList.add('hidden');
    hideResults();
    searchInput.focus();
});

// Client-side search over the bundled Madrid dataset (~11k stops). Filtering
// 11k tuples by substring is sub-millisecond, so there's no reason to hit
// /api/stops/search on every keystroke — it adds latency and load and depends
// on CRTM being up. The API is reserved for enrichment when a stop is selected
// (selectStop -> /times). The dataset is loaded on-demand the first time the
// user searches if it isn't already in memory (e.g. on mobile).
const SEARCH_CAP = 30;
async function doSearch(q) {
    if (!state.allStops || !state.allStops.length) {
        await loadStops();
        // The query may have changed while loading; re-read the live input.
        const cur = searchInput.value.trim();
        if (cur.length < 2) return;
        q = cur;
    }
    if (!state.allStops.length) {
        showResultsError('No se pudo cargar el listado de paradas');
        return;
    }

    const needle = q.toLowerCase();
    const matches = [];
    for (const s of state.allStops) {
        // tuple: [cod, short, mode, name, lat, lng]
        const cod = String(s[0] || '');
        const short = String(s[1] || '');
        const name = String(s[3] || '');
        if (name.toLowerCase().includes(needle)
            || cod.toLowerCase().includes(needle)
            || short.toLowerCase().includes(needle)) {
            matches.push({
                codStop: cod,
                shortCodStop: short,
                codMode: s[2],
                name,
                coordinates: { latitude: s[4], longitude: s[5] },
            });
            if (matches.length >= SEARCH_CAP) break;
        }
    }
    showResults(matches);
}

function showResultsError(msg) {
    searchResults.innerHTML = `<div class="empty-msg"><p>${esc(msg)}</p></div>`;
    searchResults.classList.remove('hidden');
    favSection.classList.add('hidden');
}

function showResults(stops) {
    if (!stops.length) {
        searchResults.innerHTML = '<div class="empty-msg"><p>Sin resultados</p></div>';
        searchResults.classList.remove('hidden');
        favSection.classList.add('hidden');
        return;
    }

    searchResults.innerHTML = stops.map(s => `
    <div class="stop-item" role="button" tabindex="0" data-cod="${esc(s.codStop)}" data-name="${esc(s.name)}"
         data-lat="${s.coordinates?.latitude || ''}" data-lng="${s.coordinates?.longitude || ''}">
      <div class="stop-badge" aria-hidden="true">${modeIcon(s.codMode)}</div>
      <div class="stop-info">
        <div class="stop-name">${esc(s.name)}</div>
        <div class="stop-addr">${esc(s.address || s.municipality || '')}</div>
      </div>
      <span class="code-tag">${esc(s.shortCodStop || s.codStop)}</span>
    </div>`).join('');

    searchResults.classList.remove('hidden');
    favSection.classList.add('hidden');
    bindStopClicks(searchResults);

    if (isDesktop) {
        ensureMap().then(() => {
            clearMarkers();
            stops.forEach(s => { if (s.coordinates) addMarker(s); });
            fitMarkers();
        });
    }
}

function hideResults() {
    searchResults.classList.add('hidden');
    searchResults.innerHTML = '';
    favSection.classList.remove('hidden');
}

function bindStopClicks(container) {
    container.querySelectorAll('[data-cod]').forEach(el => {
        const handler = () => {
            selectStop(el.dataset.cod, el.dataset.name, +el.dataset.lat || null, +el.dataset.lng || null);
        };
        el.addEventListener('click', handler);
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
        });
    });
}

// --- Select Stop ---
function selectStop(codStop, name, lat, lng, opts = {}) {
    state.currentStop = { codStop, name, lat, lng };
    etaStopName.textContent = name || codStop;
    etaStopCode.textContent = codStop;
    document.title = `${name || codStop} — B4us`;
    etaPanel.classList.remove('hidden');
    searchResults.classList.add('hidden');
    favSection.classList.add('hidden');
    etaEmpty.classList.add('hidden');
    arrivalsList.innerHTML = '<div class="skeleton" aria-hidden="true"><div class="sk-row"></div><div class="sk-row"></div><div class="sk-row"></div></div>';
    updateFavBtn();
    state.notifiedKeys.clear();

    if (!opts.fromHistory) {
        try {
            const target = `${BASE_PATH}stop/${encodeURIComponent(codStop)}`;
            if (location.pathname !== target) history.pushState({ codStop, name }, '', target);
        } catch { /* noop */ }
    }

    if (isDesktop && lat && lng && !isNaN(lat)) {
        ensureMap().then(() => {
            suppressPanSearch = true;
            map.flyTo([lat, lng], 16, { duration: 0.6 });
            highlightMarker(codStop);
        });
    }

    fetch(`${API_BASE}/api/stops/${encodeURIComponent(codStop)}/times`)
        .then(async r => {
            if (r.ok) return r.json();
            if (r.status === 502 || r.status === 503) {
                showUpstreamBanner();
                // Replace skeleton with explicit "no data" state so the user
                // doesn't sit watching loading dots forever. SSE will still
                // try in the background and renderArrivals takes over once
                // upstream recovers.
                if (state.currentStop?.codStop === codStop) showEtaUpstreamError();
            }
            throw r;
        })
        .then(d => {
            // Render the first paint as soon as /times resolves, even if the
            // SSE has already opened. Some proxies (e.g. cloudflared) buffer
            // small SSE responses, so onopen can fire while no `update` event
            // has actually reached the browser — relying on SSE alone leaves
            // the skeleton hanging. SSE updates will overwrite this shortly.
            if (state.currentStop?.codStop === codStop) {
                if (d.lineStatuses) state.lineStatuses = d.lineStatuses;
                // Enrich the title with the canonical CRTM stop name when the
                // local dataset only had a code/short name. No extra request:
                // it comes back on the /times payload we already fetched.
                if (d.stopName && d.stopName !== state.currentStop.name) {
                    state.currentStop.name = d.stopName;
                    etaStopName.textContent = d.stopName;
                    document.title = `${d.stopName} — B4us`;
                }
                renderArrivals(d);
            }
        })
        .catch(() => {/* SSE will retry */});

    connectSSE(codStop);

    if (!isDesktop && state.mapExpanded) {
        mapContainer.classList.remove('expanded');
        state.mapExpanded = false;
    }

    // Stop favorites polling — the SSE owns updates while we're in this view.
    stopFavoritesPolling();
}

// --- Reconnecting EventSource ---
// Native EventSource stops reconnecting on 5xx and has no exponential
// backoff. Wrap it ourselves: respect server `retry:` if set, cap our
// own backoff at 30s, jittered.
function connectSSE(codStop) {
    disconnectSSE();
    state.lastEventId = 0;
    state.eventSourceBackoffMs = 1000;
    state.eventSourceUrl = `${API_BASE}/api/sse/stop/${encodeURIComponent(codStop)}`;
    setConn('retry');
    openSSE();
}

function openSSE() {
    if (!state.eventSourceUrl) return;
    const url = state.eventSourceUrl;
    const es = new EventSource(url);
    state.eventSource = es;

    es.addEventListener('update', (e) => {
        if (e.lastEventId) state.lastEventId = e.lastEventId;
        try {
            const data = JSON.parse(e.data);
            if (data.lineStatuses) state.lineStatuses = data.lineStatuses;
            renderArrivals(data);
            setConn('on');
            // success → reset backoff to base
            state.eventSourceBackoffMs = 1000;
        } catch (err) { console.error('SSE parse:', err); }
    });

    es.addEventListener('error', () => {
        // Some upstream errors are emitted as "error" frames — keep silent.
    });

    es.onopen = () => setConn('on');

    es.onerror = () => {
        // Native ES will close on hard error; reconnect with backoff.
        if (es.readyState === EventSource.CLOSED || es.readyState === EventSource.CONNECTING) {
            try { es.close(); } catch {/*noop*/}
            state.eventSource = null;
            setConn('retry');
            scheduleReconnect();
        }
    };
}

function scheduleReconnect() {
    if (!state.eventSourceUrl) return;
    if (state.eventSourceTimer) return;
    const jitter = Math.random() * 0.4 + 0.8; // 0.8x..1.2x
    const wait = Math.min(30000, state.eventSourceBackoffMs * jitter);
    state.eventSourceTimer = setTimeout(() => {
        state.eventSourceTimer = null;
        if (!state.eventSourceUrl) return;
        openSSE();
    }, wait);
    state.eventSourceBackoffMs = Math.min(30000, state.eventSourceBackoffMs * 2);
}

function disconnectSSE() {
    if (state.eventSourceTimer) { clearTimeout(state.eventSourceTimer); state.eventSourceTimer = null; }
    if (state.eventSource) { try { state.eventSource.close(); } catch {/*noop*/} state.eventSource = null; }
    if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
    state.eventSourceUrl = null;
    setConn('off');
}

// Reconnect aggressively when network comes back.
window.addEventListener('online', () => {
    if (state.eventSourceUrl && !state.eventSource && !state.eventSourceTimer) {
        state.eventSourceBackoffMs = 500;
        scheduleReconnect();
    }
    if (!state.currentStop) refreshFavoritesETA();
});

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        // If we have an open stop and SSE is dead, reconnect.
        if (state.eventSourceUrl && !state.eventSource && !state.eventSourceTimer) {
            state.eventSourceBackoffMs = 500;
            scheduleReconnect();
        }
        // If we're on the favorites view, refresh once.
        if (!state.currentStop) refreshFavoritesETA();
    }
});

function setConn(s) {
    connDot.className = 'conn-dot' + (s === 'on' ? ' on' : s === 'retry' ? ' retry' : '');
    connText.textContent = s === 'on' ? 'En tiempo real' : s === 'retry' ? 'Reconectando...' : 'Desconectado';
}

// --- Render Arrivals ---
// Honest rendering + in-place diffing:
//  - Group by lineCode:direction (so Metro "1" and an urbano "1" never collapse).
//  - Each arrival shows a live ("en vivo", green dot) or schedule ("horario")
//    indicator strictly from a.realtime — we never imply GPS for a timetable row.
//  - lineStatuses entries with hasArrival===false render a discreet "sin tiempo
//    real" chip instead of vanishing.
//  - Rows are reconciled in place (keyed by data-key) so the per-second
//    countdown, animations and aria-live don't reset on every SSE frame.
function renderArrivals(data) {
    const arr = data.arrivals || [];
    if (data.serverEpoch) {
        const newDelta = Date.now() - data.serverEpoch;
        state.serverTimeDelta = state.serverTimeDelta
            ? Math.round(state.serverTimeDelta * 0.7 + newDelta * 0.3)
            : newDelta;
    }

    if (!arr.length) {
        // Still surface no-time lines below the empty hint via the empty state.
        arrivalsList.innerHTML = '';
        renderEmptyState(data);
        etaEmpty.classList.remove('hidden');
        etaUpdated.textContent = '⚡ ' + fmtTime(new Date());
        return;
    }
    etaEmpty.classList.add('hidden');

    for (const a of arr) {
        const key = `${a.lineCode}:${a.direction}:${a.codIssue || a.arrivalEpoch}`;
        const prev = state.lastEpochs[key];
        if (prev && Math.abs(a.arrivalEpoch - prev) < 60000) {
            a.arrivalEpoch = Math.round(a.arrivalEpoch * 0.8 + prev * 0.2);
        }
        state.lastEpochs[key] = a.arrivalEpoch;
    }

    // Group by codLine + direction (NOT shortDescription / a.line) so different
    // modes that share a public number stay distinct at interchanges.
    const groups = new Map();
    for (const a of arr) {
        const gKey = `${a.lineCode}:${a.direction}`;
        if (!groups.has(gKey)) groups.set(gKey, []);
        const g = groups.get(gKey);
        if (g.length < 2) g.push(a);
    }

    const sorted = [...groups.entries()].sort((a, b) => a[1][0].arrivalEpoch - b[1][0].arrivalEpoch);

    // Build the desired, ordered list of rows.
    const items = [];
    for (const [gKey, group] of sorted) {
        items.push({ key: gKey, type: 'arrival', first: group[0], second: group[1] });
    }

    // Lines that serve this stop but have no real-time arrival right now.
    // Prefer the explicit contract flag (hasArrival===false); fall back to "not
    // present in arrivals" for older payloads.
    const seenLines = new Set(arr.map(a => a.lineCode));
    for (const [code, s] of Object.entries(state.lineStatuses || {})) {
        const hasArrival = s && typeof s.hasArrival === 'boolean' ? s.hasArrival : seenLines.has(code);
        if (hasArrival) continue;
        const name = (s && s.lineName) || code.split('__')[1] || '?';
        items.push({ key: `notime:${code}`, type: 'notime', code, name });
    }

    reconcileArrivals(items);
    etaUpdated.textContent = '⚡ ' + fmtTime(new Date());
    startCountdown();
}

// Reconcile the arrivals list against `items` (ordered) without blowing away
// the DOM each frame: update existing rows, create missing ones, drop stale
// ones, then reorder to match.
function reconcileArrivals(items) {
    const existing = new Map();
    for (const el of Array.from(arrivalsList.children)) {
        const k = el.dataset.key;
        if (k) existing.set(k, el); else el.remove();
    }

    const wanted = new Set(items.map(i => i.key));
    for (const [k, el] of existing) {
        if (!wanted.has(k)) { el.remove(); existing.delete(k); }
    }

    let prevEl = null;
    items.forEach((item, idx) => {
        let el = existing.get(item.key);
        if (el) {
            (item.type === 'arrival' ? updateArrivalCard : updateNotimeRow)(el, item);
        } else {
            el = (item.type === 'arrival' ? buildArrivalCard : buildNotimeRow)(item, idx);
            existing.set(item.key, el);
        }
        // Place in correct order.
        const ref = prevEl ? prevEl.nextSibling : arrivalsList.firstChild;
        if (el !== ref) arrivalsList.insertBefore(el, ref);
        prevEl = el;
    });
}

// "en vivo" (live GPS) vs "horario" (timetable) — driven solely by a.realtime.
function sourceBadge(a) {
    if (a.inferred) {
        return '<span class="arr-source live" title="Estimado por posición GPS del bus">≈ estimado</span>';
    }
    return a.realtime === true
        ? '<span class="arr-source live" title="Predicción GPS en vivo">en vivo</span>'
        : '<span class="arr-source sched" title="Hora de horario — no en vivo">horario</span>';
}

function buildArrivalCard(item, idx) {
    const card = document.createElement('div');
    card.className = 'arrival-card';
    card.dataset.key = item.key;
    card.style.animationDelay = `${idx * 0.04}s`;
    card.innerHTML = `
      <div class="line-badge" aria-hidden="true"></div>
      <div class="arr-info">
        <div class="arr-dest"></div>
        <div class="arr-meta"></div>
      </div>
      <div class="arr-eta">
        <div class="countdown" aria-label="Llega en">--:--</div>
        <div class="eta-sub">min:seg</div>
        <div class="eta-abs"></div>
      </div>
      <div class="next-wrap"></div>`;
    updateArrivalCard(card, item);
    return card;
}

function updateArrivalCard(card, item) {
    const { first, second } = item;
    const c = lineColor(first.line);

    const badge = card.querySelector('.line-badge');
    badge.style.background = c;
    if (badge.textContent !== String(first.line)) badge.textContent = first.line;

    const dest = card.querySelector('.arr-dest');
    const destTxt = first.destination || 'Destino desconocido';
    if (dest.textContent !== destTxt) dest.textContent = destTxt;

    const meta = card.querySelector('.arr-meta');
    const metaHtml = `${first.isNight ? '<span class="arr-night">🌙 Búho</span>' : ''}${sourceBadge(first)}`;
    if (meta.innerHTML !== metaHtml) meta.innerHTML = metaHtml;

    const cd = card.querySelector('.arr-eta > .countdown');
    cd.dataset.epoch = first.arrivalEpoch;
    cd.dataset.line = first.line;
    const abs = card.querySelector('.arr-eta > .eta-abs');
    abs.textContent = fmtTime(new Date(first.arrivalTime));

    // Secondary "Siguiente" row, kept inside the same keyed card.
    const wrap = card.querySelector('.next-wrap');
    if (second) {
        wrap.innerHTML = `
          <div class="arrival-card next-bus">
            <div class="line-badge-sm" style="background:${c}" aria-hidden="true">${esc(second.line)}</div>
            <div class="arr-info"><div class="arr-dest next-label">Siguiente →</div></div>
            <div class="arr-eta">
              <div class="countdown" data-epoch="${second.arrivalEpoch}" data-line="${esc(second.line)}" aria-label="Siguiente">--:--</div>
              <div class="eta-sub">min:seg</div>
              <div class="eta-abs">${esc(fmtTime(new Date(second.arrivalTime)))}</div>
            </div>
          </div>`;
    } else if (wrap.firstChild) {
        wrap.innerHTML = '';
    }
}

function buildNotimeRow(item) {
    const row = document.createElement('div');
    row.className = 'line-notime';
    row.dataset.key = item.key;
    row.innerHTML = `
      <div class="line-badge-sm" aria-hidden="true"></div>
      <div class="line-notime-text"></div>`;
    updateNotimeRow(row, item);
    return row;
}

function updateNotimeRow(row, item) {
    const badge = row.querySelector('.line-badge-sm');
    badge.style.background = lineColor(item.name);
    if (badge.textContent !== String(item.name)) badge.textContent = item.name;
    const txt = row.querySelector('.line-notime-text');
    const t = `Línea ${item.name} — sin tiempo real (consultar horario)`;
    if (txt.textContent !== t) { txt.textContent = t; row.title = item.code; }
}

// Empty state: don't claim "service has ended" — CRTM regularly returns no
// times for stops whose lines exist but have no real-time data exposed
// (e.g. mode 9 — urbanos de municipios — never appears in `times.Time`
// even with SAEStatus=true). Surface the known lines so the user can see
// which routes pass by, with a clear hint about what's missing.
function renderEmptyState(data) {
    const titleEl = document.getElementById('eta-empty-title');
    const hintEl = document.getElementById('eta-empty-hint');
    const linesEl = document.getElementById('eta-empty-lines');
    if (!titleEl || !hintEl || !linesEl) return;

    const statuses = (data && data.lineStatuses) || state.lineStatuses || {};
    const entries = Object.entries(statuses);
    const hour = new Date().getHours();
    const isLateNight = hour >= 1 && hour < 5;

    if (entries.length) {
        titleEl.textContent = 'Sin llegadas en vivo';
        hintEl.textContent = isLateNight
            ? 'CRTM no devuelve tiempos a esta hora. Líneas que pasan por esta parada:'
            : 'CRTM no devuelve tiempos para esta parada ahora. Líneas conocidas:';
        linesEl.innerHTML = entries.map(([codLine, s]) => {
            const name = s?.lineName || codLine.split('__')[1] || '?';
            const live = s?.saeActive;
            return `<span class="empty-line-badge" style="background:${lineColor(name)}"
                          title="${esc(codLine)}${live ? ' · GPS activo en CRTM' : ' · sólo horario'}">
                      ${esc(name)}${live ? '' : ' <small>◦</small>'}
                    </span>`;
        }).join('');
    } else {
        titleEl.textContent = 'Sin llegadas en vivo';
        hintEl.textContent = isLateNight
            ? 'A esta hora muchas líneas no tienen tiempo real disponible'
            : 'CRTM no está devolviendo tiempos para esta parada ahora mismo';
        linesEl.innerHTML = '';
    }
}

function startCountdown() {
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    tick();
    state.countdownTimer = setInterval(tick, 1000);
}

function tick() {
    const now = Date.now() - state.serverTimeDelta;
    arrivalsList.querySelectorAll('.countdown[data-epoch]').forEach(el => {
        const ep = +el.dataset.epoch;
        const sec = Math.max(0, Math.floor((ep - now) / 1000));
        const m = Math.floor(sec / 60);
        const s = sec % 60;

        if (sec === 0) {
            el.textContent = '⟶';
            el.className = 'countdown imminent';
            setSib(el, 'EN PARADA');
            maybeNotifyArrival(el, ep);
        } else if (sec < 60) {
            el.textContent = `0:${pad(s)}`;
            el.className = 'countdown imminent';
            setSib(el, 'segundos');
            if (sec <= 10) maybeNotifyArrival(el, ep);
        } else if (m <= 3) {
            el.textContent = `${m}:${pad(s)}`;
            el.className = 'countdown arriving';
            setSib(el, 'min:seg');
        } else {
            el.textContent = `${m}:${pad(s)}`;
            el.className = 'countdown normal';
            setSib(el, 'min:seg');
        }
    });
}
function setSib(el, t) { const n = el.nextElementSibling; if (n) n.textContent = t; }
function pad(n) { return String(n).padStart(2, '0'); }

// --- Vibration + audio cue ---
// Fire once per (line, epoch) to avoid pulsing the device every second.
function maybeNotifyArrival(el, epoch) {
    const line = el.dataset.line || 'x';
    const key = `${line}:${epoch}`;
    if (state.notifiedKeys.has(key)) return;
    state.notifiedKeys.add(key);

    if (state.prefs.vibrate && navigator.vibrate) {
        try { navigator.vibrate([180, 80, 180]); } catch {/*noop*/}
    }
    if (state.prefs.sound) playDing();
}

function playDing() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!state.audioCtx) state.audioCtx = new Ctx();
        const ctx = state.audioCtx;
        if (ctx.state === 'suspended') ctx.resume();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sine';
        o.frequency.setValueAtTime(880, ctx.currentTime);
        o.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.18);
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
        o.start();
        o.stop(ctx.currentTime + 0.3);
    } catch (e) { /* audio cues are best-effort */ }
}

// --- Favorites (multi-stop dashboard) ---
function loadFavs() {
    if (!state.favorites.length) {
        favEmpty.classList.remove('hidden');
        favList.innerHTML = '';
        return;
    }
    favEmpty.classList.add('hidden');
    favList.innerHTML = state.favorites.map(f => `
    <div class="fav-item" role="listitem" tabindex="0" data-cod="${esc(f.codStop)}" data-name="${esc(f.name)}"
         data-lat="${f.lat || ''}" data-lng="${f.lng || ''}">
      <div class="stop-badge">⭐</div>
      <div class="stop-info">
        <div class="stop-name">${esc(f.name)}</div>
        <div class="stop-addr">${esc(f.codStop)}</div>
      </div>
      <div class="fav-eta" data-cod="${esc(f.codStop)}">
        <span class="fav-eta-loading">…</span>
      </div>
    </div>`).join('');
    bindStopClicks(favList);

    refreshFavoritesETA();
    startFavoritesPolling();
}

let favCountdownStarted = false;
async function refreshFavoritesETA() {
    if (!state.favorites.length) return;
    const tasks = state.favorites.map(async (f) => {
        try {
            const r = await fetch(`${API_BASE}/api/stops/${encodeURIComponent(f.codStop)}/times`, { cache: 'no-store' });
            if (!r.ok) throw new Error(String(r.status));
            const d = await r.json();
            return { cod: f.codStop, data: d };
        } catch (err) {
            return { cod: f.codStop, error: err.message || 'err' };
        }
    });
    const results = await Promise.all(tasks);
    for (const res of results) {
        const slot = favList.querySelector(`.fav-eta[data-cod="${cssEsc(res.cod)}"]`);
        if (!slot) continue;
        if (res.error) {
            slot.innerHTML = `<span class="fav-eta-error">⚠</span>`;
            continue;
        }
        const next = (res.data?.arrivals || [])[0];
        if (!next) {
            slot.innerHTML = `<span class="fav-eta-loading">—</span>`;
            continue;
        }
        slot.innerHTML = `
          <span class="fav-line" style="color:${lineColor(next.line)}">L ${esc(next.line)}</span>
          <span class="countdown" data-epoch="${next.arrivalEpoch}">--:--</span>
        `;
    }
    if (!favCountdownStarted) {
        favCountdownStarted = true;
        if (state.favTickTimer) clearInterval(state.favTickTimer);
        state.favTickTimer = setInterval(tickFavs, 1000);
    }
    tickFavs();
}

function tickFavs() {
    const now = Date.now() - state.serverTimeDelta;
    favList.querySelectorAll('.fav-eta .countdown[data-epoch]').forEach(el => {
        const ep = +el.dataset.epoch;
        const sec = Math.max(0, Math.floor((ep - now) / 1000));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        if (sec === 0) { el.textContent = '⟶'; el.className = 'countdown imminent'; }
        else if (sec < 60) { el.textContent = `0:${pad(s)}`; el.className = 'countdown imminent'; }
        else if (m <= 3) { el.textContent = `${m}:${pad(s)}`; el.className = 'countdown arriving'; }
        else { el.textContent = `${m}:${pad(s)}`; el.className = 'countdown normal'; }
    });
}

function startFavoritesPolling() {
    stopFavoritesPolling();
    if (!state.prefs.autoRefresh) return;
    state.favPollTimer = setInterval(() => {
        if (!document.hidden && !state.currentStop) refreshFavoritesETA();
    }, 30000);
}

function stopFavoritesPolling() {
    if (state.favPollTimer) { clearInterval(state.favPollTimer); state.favPollTimer = null; }
    if (state.favTickTimer && state.currentStop) {
        // keep the tick timer running across views — it's cheap; only stop when leaving favs entirely
    }
}

function toggleFav() {
    if (!state.currentStop) return;
    const { codStop, name, lat, lng } = state.currentStop;
    const i = state.favorites.findIndex(f => f.codStop === codStop);
    if (i >= 0) state.favorites.splice(i, 1);
    else state.favorites.push({ codStop, name, lat, lng });
    localStorage.setItem(FAV_KEY, JSON.stringify(state.favorites));
    updateFavBtn();
    loadFavs();
}

function updateFavBtn() {
    if (!state.currentStop) return;
    const is = state.favorites.some(f => f.codStop === state.currentStop.codStop);
    btnFav.classList.toggle('active', is);
    btnFav.setAttribute('aria-pressed', String(is));
}

// --- Share ---
async function shareCurrentStop() {
    if (!state.currentStop) return;
    const { codStop, name } = state.currentStop;
    const url = `${location.origin}${BASE_PATH}stop/${encodeURIComponent(codStop)}`;
    const title = `${name || codStop} — B4us`;
    const text = `Tiempos en vivo de la parada ${codStop}: ${url}`;
    if (navigator.share) {
        try { await navigator.share({ title, text, url }); return; } catch (e) {/* user cancelled */ }
    }
    try {
        await navigator.clipboard.writeText(url);
        flashToast('🔗 Enlace copiado');
    } catch {
        prompt('Copia este enlace:', url);
    }
}

function flashToast(msg) {
    incidentBanner.querySelector('span:nth-child(2)') &&
        (incidentBanner.querySelector('span:nth-child(2)').textContent = msg);
    incidentBanner.classList.remove('hidden');
    setTimeout(() => incidentBanner.classList.add('hidden'), 2200);
}

// --- Nearby ---
async function nearby() {
    if (!navigator.geolocation) { alert('Geolocalización no disponible'); return; }
    btnNearby.disabled = true;
    try {
        const pos = await new Promise((ok, fail) => navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: true, timeout: 10000 }));
        const { latitude: lat, longitude: lng } = pos.coords;
        if (isDesktop) {
            await ensureMap();
            suppressPanSearch = true;
            map.flyTo([lat, lng], 15, { duration: 0.8 });
            L.circleMarker([lat, lng], { radius: 8, fillColor: '#3b82f6', fillOpacity: 0.8, color: '#fff', weight: 2 })
                .addTo(map).bindPopup('📍 Tu ubicación');
        }
        const r = await fetch(`${API_BASE}/api/stops/nearby?lat=${lat}&lng=${lng}&radius=600`);
        if (!r.ok) {
            if (r.status === 502 || r.status === 503) showUpstreamBanner();
            return;
        }
        const d = await r.json();
        showResults(d.stops || []);
    } catch { alert('No se pudo obtener tu ubicación'); }
    finally { btnNearby.disabled = false; }
}

// --- Map Markers ---
// state.allStops holds the FULL Madrid dataset (~11k entries). state.markers
// holds the Leaflet markers currently on the map (only those in viewport).
// state.markersByCode maps codStop → marker for fast lookup on update.

const MODE_INFO = {
    4:  { cls: 'mode-metro',    label: 'Metro' },
    5:  { cls: 'mode-cercanias', label: 'Cercanías' },
    6:  { cls: 'mode-emt',      label: 'EMT' },
    8:  { cls: 'mode-interurb', label: 'Interurbano' },
    10: { cls: 'mode-ml',       label: 'Metro Ligero' },
};

// Per-zoom rules for what to show:
// - <11: nothing (way too zoomed out)
// - 11-12: only metro + cercanías (city-level overview)
// - 13: + interurbano major
// - 14+: everything in viewport, capped at 800
const VIEWPORT_CAP = 800;

function modesForZoom(z) {
    if (z >= 14) return new Set([4, 5, 6, 8, 10]);
    if (z >= 13) return new Set([4, 5, 8, 10]);
    if (z >= 11) return new Set([4, 5]);
    return new Set();
}

function clearMarkers() {
    if (!isDesktop) return;
    state.markers.forEach(m => map.removeLayer(m));
    state.markers = [];
    state.markersByCode = new Map();
}

// Build a marker from a compact stop tuple [cod, short, mode, name, lat, lng]
// or from the legacy CRTM API object {codStop, name, coordinates: {latitude, longitude}}.
function addMarker(stop) {
    if (!isDesktop) return null;
    let cod, name, lat, lng, mode;
    if (Array.isArray(stop)) {
        [cod, , mode, name, lat, lng] = stop;
    } else {
        if (!stop.coordinates) return null;
        cod = stop.codStop; name = stop.name;
        lat = stop.coordinates.latitude; lng = stop.coordinates.longitude;
        mode = parseInt(stop.codMode, 10) || 8;
    }
    if (state.markersByCode?.has(cod)) return state.markersByCode.get(cod);
    const info = MODE_INFO[mode] || MODE_INFO[8];
    const icon = L.divIcon({ className: `bus-stop-marker ${info.cls}`, iconSize: [16, 16], iconAnchor: [8, 8] });
    // `keyboard: false` removes the auto-injected tabindex/role=button so
    // Leaflet markers don't fight Lighthouse's "touch target ≥ 24px" rule.
    // The map stays interactive via clicks; keyboard users use the list /
    // search / favourites flow.
    const m = L.marker([lat, lng], { icon, keyboard: false, alt: `${info.label} ${name}`, title: name }).addTo(map).bindPopup(`
    <div style="min-width:160px">
      <strong style="font-size:13px">${esc(name)}</strong>
      <span class="mode-pill ${info.cls}">${esc(info.label)}</span><br>
      <small style="opacity:0.6">${esc(cod)}</small><br>
      <button class="popup-select" data-cod="${esc(cod)}" data-name="${esc(name)}" data-lat="${lat}" data-lng="${lng}"
        style="margin-top:6px;padding:5px 12px;border:none;border-radius:8px;background:#8EBF42;color:#fff;cursor:pointer;font-weight:600;font-size:12px">
        Ver tiempos
      </button>
    </div>`);
    m._cod = cod;
    m._mode = mode;
    state.markers.push(m);
    if (!state.markersByCode) state.markersByCode = new Map();
    state.markersByCode.set(cod, m);
    return m;
}

// Render only stops visible in the current viewport, respecting zoom rules.
// Diff against the current marker set so we don't recreate everything on each pan.
function renderViewport() {
    if (!isDesktop || !map) return;
    const stops = state.allStops || [];
    if (!stops.length) return;

    const z = map.getZoom();
    const allowedModes = modesForZoom(z);
    if (!state.markersByCode) state.markersByCode = new Map();

    if (allowedModes.size === 0) {
        clearMarkers();
        return;
    }

    const b = map.getBounds().pad(0.05);
    const minLat = b.getSouth(), maxLat = b.getNorth();
    const minLng = b.getWest(), maxLng = b.getEast();

    // Find candidates in viewport for the allowed modes
    const candidates = [];
    for (const s of stops) {
        const mode = s[2], lat = s[4], lng = s[5];
        if (!allowedModes.has(mode)) continue;
        if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) continue;
        candidates.push(s);
    }

    // If too many, prefer rail (metro/cercanías/ML) > interurbano > EMT
    const priorityFor = m => m === 4 ? 0 : m === 5 ? 1 : m === 10 ? 2 : m === 8 ? 3 : 4;
    if (candidates.length > VIEWPORT_CAP) {
        candidates.sort((a, b) => priorityFor(a[2]) - priorityFor(b[2]));
        candidates.length = VIEWPORT_CAP;
    }

    const wantSet = new Set(candidates.map(s => s[0]));

    // Remove markers no longer in viewport
    for (const [cod, m] of state.markersByCode) {
        if (!wantSet.has(cod)) {
            map.removeLayer(m);
            state.markersByCode.delete(cod);
        }
    }
    // Add new markers
    for (const s of candidates) {
        if (!state.markersByCode.has(s[0])) addMarker(s);
    }
    state.markers = Array.from(state.markersByCode.values());
}

function highlightMarker(cod) {
    if (!isDesktop) return;
    state.markers.forEach(m => {
        const el = m.getElement();
        if (el) el.classList.toggle('active', m._cod === cod);
    });
}

function fitMarkers() {
    if (!isDesktop || !state.markers.length) return;
    // Sanity: only fit to markers that are within the Madrid metro bbox so a
    // bogus stop in the response can't yank the map to the sierra norte.
    const local = state.markers.filter(m => {
        const ll = m.getLatLng();
        return isInMadrid(ll.lat, ll.lng);
    });
    const target = local.length ? local : state.markers;
    suppressPanSearch = true;
    map.fitBounds(L.featureGroup(target).getBounds().pad(0.15), { maxZoom: 15 });
}

// --- Preferences ---
function openPrefs() {
    prefVibrate.checked = !!state.prefs.vibrate;
    prefSound.checked = !!state.prefs.sound;
    prefAutoRefresh.checked = !!state.prefs.autoRefresh;
    prefsSheet.classList.remove('hidden');
}
function closePrefs() {
    prefsSheet.classList.add('hidden');
}
function persistPrefs() {
    state.prefs = {
        vibrate: prefVibrate.checked,
        sound: prefSound.checked,
        autoRefresh: prefAutoRefresh.checked,
    };
    localStorage.setItem(PREF_KEY, JSON.stringify(state.prefs));
    if (state.prefs.autoRefresh) startFavoritesPolling();
    else stopFavoritesPolling();
}

// --- Events ---
btnFav.addEventListener('click', toggleFav);
btnShare.addEventListener('click', shareCurrentStop);
btnBack.addEventListener('click', () => {
    disconnectSSE();
    etaPanel.classList.add('hidden');
    favSection.classList.remove('hidden');
    state.currentStop = null;
    document.title = 'B4us — ETA en vivo · Madrid';
    if (location.pathname.startsWith(BASE_PATH + 'stop/')) history.pushState({}, '', BASE_PATH);
    loadFavs();
});
btnNearby.addEventListener('click', nearby);
btnExpandMap.addEventListener('click', () => {
    state.mapExpanded = !state.mapExpanded;
    mapContainer.classList.toggle('expanded', state.mapExpanded);
    ensureMap().then(() => setTimeout(() => map.invalidateSize(), 350));
});
incidentClose.addEventListener('click', () => incidentBanner.classList.add('hidden'));
btnPrefs.addEventListener('click', openPrefs);
prefsClose.addEventListener('click', closePrefs);
prefsSheet.addEventListener('click', (e) => { if (e.target === prefsSheet) closePrefs(); });
[prefVibrate, prefSound, prefAutoRefresh].forEach((el) => el.addEventListener('change', persistPrefs));

if (btnMenu) {
    btnMenu.addEventListener('click', () => {
        if (!isDesktop) return;
        state.mapExpanded = !state.mapExpanded;
        mapContainer.classList.toggle('expanded', state.mapExpanded);
        ensureMap().then(() => setTimeout(() => map.invalidateSize(), 350));
    });
}

// Keyboard nav: Esc closes panels
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (!prefsSheet.classList.contains('hidden')) { closePrefs(); return; }
        if (!etaPanel.classList.contains('hidden')) { btnBack.click(); }
    }
});

// --- Deep link / popstate ---
function applyPathRoute(opts = { fromHistory: false }) {
    const prefix = BASE_PATH + 'stop/';
    const sub = location.pathname.startsWith(prefix)
        ? location.pathname.slice(prefix.length).replace(/\/$/, '')
        : null;
    if (sub) {
        const cod = decodeURIComponent(sub);
        // First try the bundled static dataset — that always works, even
        // when CRTM is down. Then upgrade to fresh CRTM data if available.
        const local = (state.allStops || []).find(s => s[0] === cod);
        const localName = local ? local[3] : cod;
        const localLat  = local ? local[4] : null;
        const localLng  = local ? local[5] : null;
        selectStop(cod, localName, localLat, localLng, opts);
        // Best-effort upgrade with CRTM-fresh metadata (address, etc).
        fetch(`${API_BASE}/api/stops/${encodeURIComponent(cod)}`).then(r => r.ok ? r.json() : null).then(info => {
            const stops = info?.stops?.Stop;
            const s = Array.isArray(stops) ? stops[0] : stops;
            if (!s) return;
            const name = s.name || localName;
            if (state.currentStop?.codStop === cod && name !== state.currentStop.name) {
                state.currentStop.name = name;
                etaStopName.textContent = name;
                document.title = `${name} — B4us`;
            }
        }).catch(() => {});
    } else {
        // Going back to root → clear selection
        if (state.currentStop) {
            disconnectSSE();
            etaPanel.classList.add('hidden');
            favSection.classList.remove('hidden');
            state.currentStop = null;
            document.title = 'B4us — ETA en vivo · Madrid';
        }
    }
}
window.addEventListener('popstate', () => applyPathRoute({ fromHistory: true }));

// --- PWA: service worker + install prompt + update notification ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
        try {
            const reg = await navigator.serviceWorker.register(BASE_PATH + 'sw.js', { scope: BASE_PATH });
            // Detect a waiting worker (new version downloaded but pending)
            if (reg.waiting) showUpdateBanner(reg);
            reg.addEventListener('updatefound', () => {
                const sw = reg.installing;
                if (!sw) return;
                sw.addEventListener('statechange', () => {
                    if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                        showUpdateBanner(reg);
                    }
                });
            });
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                window.location.reload();
            });
        } catch (e) {
            console.warn('SW register failed:', e);
        }
    });
}

function showUpdateBanner(reg) {
    updateBanner.classList.remove('hidden');
    updateReload.onclick = () => {
        if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
        else window.location.reload();
    };
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstall = e;
    btnInstall.classList.remove('hidden');
});
btnInstall.addEventListener('click', async () => {
    if (!state.deferredInstall) return;
    state.deferredInstall.prompt();
    try { await state.deferredInstall.userChoice; } catch {/*noop*/}
    state.deferredInstall = null;
    btnInstall.classList.add('hidden');
});
window.addEventListener('appinstalled', () => {
    state.deferredInstall = null;
    btnInstall.classList.add('hidden');
});

// --- Helpers ---
function esc(s) { if (s === null || s === undefined) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
function cssEsc(s) { return String(s).replace(/[^a-zA-Z0-9_\-]/g, (c) => '\\' + c); }
function fmtTime(d) { return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function modeIcon(c) { return { '4': '🚇', '5': '🚆', '6': '🚍', '8': '🚌', '10': '🚊' }[String(c)] || '🚌'; }

// --- Stop list cache (localStorage) ---
// CRTM upstream is intermittently broken. We keep the last successful stop
// list locally so the map still shows dots even when /api/* is returning
// 502/503 — TTL 7 days, more than enough for a network whose stops change
// only when CRTM rolls a route.
const STOPS_CACHE_KEY = 'bus_stops_mostoles_v1';
const STOPS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function loadCachedStops() {
    try {
        const raw = localStorage.getItem(STOPS_CACHE_KEY);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (!o.ts || Date.now() - o.ts > STOPS_CACHE_TTL_MS) return null;
        return Array.isArray(o.stops) ? o.stops : null;
    } catch { return null; }
}

function saveCachedStops(stops) {
    try {
        localStorage.setItem(STOPS_CACHE_KEY, JSON.stringify({ ts: Date.now(), stops }));
    } catch {/*storage full / private mode*/}
}

// --- Load the full Madrid GTFS dataset on-demand ---
// d.stops is array of [cod, short, mode, name, lat, lng] (~11k entries).
// Both the desktop map and the client-side search consume it. Cached as a
// promise so concurrent callers (loadInitial + first search keystroke) share
// a single fetch. The SW serves it stale-while-revalidate, so this is cheap.
let _stopsPromise = null;
function loadStops() {
    if (state.allStops && state.allStops.length) return Promise.resolve(state.allStops);
    if (_stopsPromise) return _stopsPromise;
    _stopsPromise = fetch(`${BASE_PATH}madrid-stops.json`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error('madrid-stops.json ' + r.status)))
        .then(d => {
            state.allStops = d.stops || [];
            console.info(`Loaded ${state.allStops.length} Madrid stops`);
            return state.allStops;
        })
        .catch(e => { _stopsPromise = null; console.warn('madrid-stops.json:', e.message); return []; });
    return _stopsPromise;
}

// --- Load initial stops (desktop map only) ---
// Loads the full Madrid GTFS dataset (interurbano + EMT + metro + cercanías
// + ML). Markers get filtered by viewport on every map move/zoom — this is
// independent of CRTM upstream, so the map is always populated and useful.
async function loadInitial() {
    if (!isDesktop) return;

    // Probe the live API once to know if upstream is up; ETAs depend on it.
    fetch(`${API_BASE}/api/stops/${encodeURIComponent('8_08554')}/times`, { method: 'HEAD' })
        .then(r => { if (r.status === 502 || r.status === 503) showUpstreamBanner(); })
        .catch(() => {});

    try {
        await loadStops();
        await ensureMap();
        renderViewport();
    } catch (e) {
        console.warn('loadInitial:', e.message);
    }
}

function showUpstreamBanner() {
    const txt = $('#incident-text');
    if (txt) txt.textContent = 'CRTM responde lento o falla — los datos pueden tardar';
    incidentBanner.classList.remove('hidden');
    // Auto-dismiss after a while so it doesn't linger forever.
    setTimeout(() => incidentBanner.classList.add('hidden'), 8000);
}

// Show a friendly explanation in the arrivals panel when CRTM is broken.
// SSE keeps reconnecting underneath — when it gets a frame, renderArrivals
// will replace this with real data automatically.
function showEtaUpstreamError() {
    arrivalsList.innerHTML = `
      <div class="upstream-fallback">
        <div class="upstream-fallback-icon" aria-hidden="true">⚠️</div>
        <h3>Sin datos en vivo</h3>
        <p>CRTM no está respondiendo ahora mismo. Cuando vuelva, los tiempos aparecerán automáticamente.</p>
        <button id="eta-retry" class="upstream-retry-btn">Reintentar ahora</button>
        <p class="upstream-hint">El icono ${state.eventSource ? '<span class="conn-dot retry"></span>' : ''} de arriba se pondrá verde cuando CRTM responda.</p>
      </div>`;
    etaEmpty.classList.add('hidden');
    const btn = document.getElementById('eta-retry');
    if (btn) btn.addEventListener('click', () => {
        if (!state.currentStop) return;
        const { codStop, name, lat, lng } = state.currentStop;
        // Re-trigger selectStop. Skip pushState (we're already at this URL).
        selectStop(codStop, name, lat, lng, { fromHistory: true });
    });
}

// --- Theme toggle ---
// Three states: 'auto' (follows OS), 'dark', 'light'. Stored in localStorage.
const THEME_KEY = 'bus_theme_v1';
function getStoredTheme() { return localStorage.getItem(THEME_KEY) || 'auto'; }
function applyTheme(t) {
    const root = document.documentElement;
    if (t === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', t);
    // Update theme-color meta so iOS status bar matches
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
        const isLight = t === 'light' || (t === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
        meta.setAttribute('content', isLight ? '#fafafa' : '#09090b');
    }
    // Update map tiles to match theme (light_all vs dark_all)
    if (window.__bus?.map && window.__bus.tileLayer) {
        const isLight = t === 'light' || (t === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
        const url = isLight
            ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
            : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
        window.__bus.tileLayer.setUrl(url);
    }
    updateThemeIcon(t);
}
function updateThemeIcon(t) {
    if (!btnTheme) return;
    const isLight = t === 'light' || (t === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
    const sun = btnTheme.querySelector('.icon-sun');
    const moon = btnTheme.querySelector('.icon-moon');
    if (sun && moon) {
        // Show the icon for the OPPOSITE theme (the action you'd take)
        sun.style.display = isLight ? '' : 'none';
        moon.style.display = isLight ? 'none' : '';
    }
}
function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(getStoredTheme()) + 1) % order.length];
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    flashToast(`tema · ${next}`);
}
applyTheme(getStoredTheme());
if (btnTheme) btnTheme.addEventListener('click', cycleTheme);
// React to OS theme changes when in "auto" mode
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getStoredTheme() === 'auto') applyTheme('auto');
});

// --- Init ---
loadFavs();
setConn('off');
// Load the static dataset BEFORE applying any route so deep links can
// resolve stop names from local data without waiting on CRTM.
loadInitial().then(() => applyPathRoute({ fromHistory: true }));

// Optional shortcut from PWA shortcuts: /?action=nearby
if (new URLSearchParams(location.search).get('action') === 'nearby') {
    setTimeout(nearby, 200);
}
