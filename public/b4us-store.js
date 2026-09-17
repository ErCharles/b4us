'use strict';

/* ============================================
   B4us Store — carpetas, favoritos y corte de sondeo
   --------------------------------------------
   Script clásico (app.js usa `B4usStore`) y módulo CJS para `node --test`.
   Sin dependencias, sin red, sin backend.

   Claves (solo localStorage):
     b4us_device_id   string  UUID v4, se crea en el primer getDeviceId()
     b4us_folders_v1  JSON    [{ id, name, color? }]
     bus_favs         JSON    [{ codStop, name, lat?, lng?, alias?, folderId?, order? }]

   La carpeta implícita "Favoritos" NO se persiste: es el nodo virtual id=null,
   así los favoritos guardados antes de existir las carpetas siguen valiendo
   sin migración. `bus_prefs_v1` es de app.js: el store nunca lo toca.
   ============================================ */

const FAV_KEY = 'bus_favs';
const FOLDERS_KEY = 'b4us_folders_v1';
const DEVICE_KEY = 'b4us_device_id';
const MAX_ALIAS = 60;
const MAX_FOLDER_NAME = 40;

// --- Corte de sondeo (estados = contrato compartido con app.js y tests) ---

const ARRIVAL = Object.freeze({ OK: 'OK', PAST: 'YA_PASADO', NONE: 'SIN_HORARIO' });

// secondsLeft: segundos hasta la llegada (NaN si no hay epoch usable).
// hasTimes: el payload traía arrivals (false = API vacía / sin servicio).
function classifyArrival(secondsLeft, hasTimes) {
    if (!hasTimes) return ARRIVAL.NONE;
    const sec = Number(secondsLeft);
    if (!Number.isFinite(sec)) return ARRIVAL.NONE; // "no sé" no es "ya pasó"
    return sec > 0 ? ARRIVAL.OK : ARRIVAL.PAST;
}

// null -> queda algo que esperar (seguir con SSE / polling).
// ARRIVAL.PAST | ARRIVAL.NONE -> congelar (truthy, y el valor ES el estado de UI).
// El servidor clampea secondsLeft a 0, así que 0 = "ya salió", no "quedan 0 s".
function shouldFreezeStop(arrivals, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const list = Array.isArray(arrivals) ? arrivals : [];
    if (!list.length) return ARRIVAL.NONE;
    let sawEpoch = false;
    for (const a of list) {
        const sec = (a?.arrivalEpoch - now) / 1000;
        if (Number.isFinite(sec)) sawEpoch = true;
        if (classifyArrival(sec, true) === ARRIVAL.OK) return null;
    }
    return sawEpoch ? ARRIVAL.PAST : ARRIVAL.NONE;
}

// --- Storage (inyectable; los tests usan un fake sobre Map) ---

function storageOf(storage) {
    if (storage) return storage;
    try { return globalThis.localStorage || null; } catch { return null; }
}

function readJSON(key, storage, fallback) {
    try {
        const raw = storageOf(storage)?.getItem(key);
        const val = raw ? JSON.parse(raw) : null;
        return val && typeof val === 'object' ? val : fallback;
    } catch { return fallback; } // JSON corrupto -> estado vacío, nunca revienta
}

function writeJSON(key, value, storage) {
    try {
        const s = storageOf(storage);
        if (!s) return false;
        s.setItem(key, JSON.stringify(value));
        return true;
    } catch { return false; } // cuota llena / modo privado
}

function uuidv4() {
    const c = globalThis.crypto;
    if (c?.randomUUID) return c.randomUUID();
    if (!c?.getRandomValues) return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// --- Normalización (frontera de confianza: localStorage y fichero importado) ---

const isHexColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

function normFolder(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_FOLDER_NAME) : '';
    if (!id || !name) return null;
    return isHexColor(raw.color) ? { id, name, color: raw.color } : { id, name };
}

function normFav(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.codStop !== 'string' || !raw.codStop) return null;
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : raw.codStop;
    const f = { codStop: raw.codStop, name };
    if (Number.isFinite(raw.lat)) f.lat = raw.lat;
    if (Number.isFinite(raw.lng)) f.lng = raw.lng;
    if (typeof raw.alias === 'string' && raw.alias.trim()) f.alias = raw.alias.trim().slice(0, MAX_ALIAS);
    if (typeof raw.folderId === 'string' && raw.folderId) f.folderId = raw.folderId;
    if (Number.isFinite(raw.order)) f.order = raw.order;
    return f;
}

// Lista completa normalizada y sin duplicados (gana el primero).
function readFavs(storage) {
    const raw = readJSON(FAV_KEY, storage, []);
    const ids = new Set(getFolders(storage).map((f) => f.id));
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(raw) ? raw : []) {
        const f = normFav(item);
        if (!f || seen.has(f.codStop)) continue;
        seen.add(f.codStop);
        if (f.folderId && !ids.has(f.folderId)) delete f.folderId; // carpeta borrada -> implícita
        out.push(f);
    }
    return out;
}

const writeFavs = (list, storage) => writeJSON(FAV_KEY, list, storage);

// --- Dispositivo ---

function getDeviceId(storage) {
    const s = storageOf(storage);
    try {
        const cur = s?.getItem(DEVICE_KEY);
        if (typeof cur === 'string' && cur) return cur;
    } catch { /* modo privado */ }
    const id = uuidv4();
    try { s?.setItem(DEVICE_KEY, id); } catch { /* modo privado */ }
    return id;
}

// --- Carpetas ---

function getFolders(storage) {
    const raw = readJSON(FOLDERS_KEY, storage, []);
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(raw) ? raw : []) {
        const f = normFolder(item);
        if (f && !seen.has(f.id)) { seen.add(f.id); out.push(f); }
    }
    return out;
}

function createFolder(name, color, storage) {
    const n = typeof name === 'string' ? name.trim().slice(0, MAX_FOLDER_NAME) : '';
    if (!n) return null;
    const folders = getFolders(storage);
    const folder = { id: 'f_' + uuidv4(), name: n };
    if (isHexColor(color)) folder.color = color;
    folders.push(folder);
    writeJSON(FOLDERS_KEY, folders, storage);
    return folder;
}

function renameFolder(id, name, storage) {
    const n = typeof name === 'string' ? name.trim().slice(0, MAX_FOLDER_NAME) : '';
    if (!n) return null;
    const folders = getFolders(storage);
    const folder = folders.find((f) => f.id === id);
    if (!folder) return null;
    folder.name = n;
    writeJSON(FOLDERS_KEY, folders, storage);
    return folder;
}

// Borra la carpeta y devuelve cuántas paradas volvieron a "Favoritos".
// Las paradas nunca se borran.
function deleteFolder(id, storage) {
    const folders = getFolders(storage);
    if (!folders.some((f) => f.id === id)) return 0;
    const list = readFavs(storage); // antes de borrarla: si no, los folderId ya degradan a implícita
    writeJSON(FOLDERS_KEY, folders.filter((f) => f.id !== id), storage);
    let moved = 0;
    for (const f of list) {
        if (f.folderId === id) { delete f.folderId; delete f.order; moved++; }
    }
    if (moved) writeFavs(list, storage);
    return moved;
}

// --- Favoritos ---

// folderId: undefined = todas; null = solo la carpeta implícita; string = esa.
function getFavorites(folderId, storage) {
    const list = readFavs(storage);
    const want = folderId === undefined ? undefined : (folderId || null);
    return list
        .filter((f) => want === undefined || (f.folderId || null) === want)
        .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity)); // estable: empate = orden de array
}

function isFavorite(codStop, storage) {
    return readFavs(storage).some((f) => f.codStop === codStop);
}

function addFavorite(stop, folderId, storage) {
    const cod = stop?.codStop;
    if (typeof cod !== 'string' || !cod) return null;
    const list = readFavs(storage);
    if (list.some((f) => f.codStop === cod)) return null;
    const fid = getFolders(storage).some((f) => f.id === folderId) ? folderId : null;
    const fav = normFav({ codStop: cod, name: stop.name, lat: stop.lat, lng: stop.lng });
    const orders = list.filter((f) => (f.folderId || null) === fid && Number.isFinite(f.order)).map((f) => f.order);
    if (fid) fav.folderId = fid;
    if (orders.length) fav.order = Math.max(...orders) + 1;
    list.push(fav);
    writeFavs(list, storage);
    return fav;
}

function removeFavorite(codStop, storage) {
    const list = readFavs(storage);
    const next = list.filter((f) => f.codStop !== codStop);
    if (next.length === list.length) return false;
    writeFavs(next, storage);
    return true;
}

// Devuelve si la parada QUEDÓ como favorita.
function toggleFavorite(stop, storage) {
    const cod = stop?.codStop;
    if (typeof cod !== 'string' || !cod) return false;
    if (isFavorite(cod, storage)) { removeFavorite(cod, storage); return false; }
    addFavorite(stop, null, storage);
    return true;
}

// alias vacío -> borra el nombre personalizado (el oficial nunca se pierde).
function setAlias(codStop, alias, storage) {
    const list = readFavs(storage);
    const fav = list.find((f) => f.codStop === codStop);
    if (!fav) return null;
    const a = typeof alias === 'string' ? alias.trim().slice(0, MAX_ALIAS) : '';
    if (a) fav.alias = a; else delete fav.alias;
    writeFavs(list, storage);
    return fav;
}

// Mueve a otra carpeta (null = "Favoritos"); al entrar recibe el siguiente order.
function setFolder(codStop, folderId, storage) {
    const list = readFavs(storage);
    const fav = list.find((f) => f.codStop === codStop);
    if (!fav) return null;
    const fid = getFolders(storage).some((f) => f.id === folderId) ? folderId : null;
    if ((fav.folderId || null) === fid) return fav;
    const orders = list
        .filter((f) => f !== fav && (f.folderId || null) === fid && Number.isFinite(f.order))
        .map((f) => f.order);
    delete fav.folderId;
    delete fav.order;
    if (fid) {
        fav.folderId = fid;
        if (orders.length) fav.order = Math.max(...orders) + 1;
    }
    writeFavs(list, storage);
    return fav;
}

// Mueve dentro de SU carpeta y renumera 0..n-1. Devuelve esa carpeta ya ordenada.
function reorder(codStop, toIndex, storage) {
    const list = readFavs(storage);
    const fav = list.find((f) => f.codStop === codStop);
    if (!fav) return [];
    const group = list.filter((f) => (f.folderId || null) === (fav.folderId || null));
    const from = group.indexOf(fav);
    const to = Math.min(group.length - 1, Math.max(0, Math.trunc(Number(toIndex)) || 0));
    if (from !== to) {
        group.splice(from, 1);
        group.splice(to, 0, fav);
    }
    group.forEach((f, i) => { f.order = i; });
    writeFavs(list, storage);
    return group;
}

// --- Copia de seguridad (carpetas + favoritos; nunca prefs) ---

function exportJSON(storage) {
    return JSON.stringify({
        deviceId: getDeviceId(storage),
        folders: getFolders(storage),
        favorites: readFavs(storage),
    }, null, 2);
}

// Merge aditivo por codStop. NUNCA lanza y NUNCA borra datos locales.
function importJSON(text, storage) {
    const fail = { ok: false, error: 'formato', added: 0, updated: 0, foldersAdded: 0 };
    let data;
    try { data = JSON.parse(text); } catch { return fail; }
    if (!data || typeof data !== 'object' || !Array.isArray(data.folders) || !Array.isArray(data.favorites)) return fail;

    try {
        const folders = getFolders(storage);
        const ids = new Set(folders.map((f) => f.id));
        let foldersAdded = 0;
        for (const raw of data.folders) {
            const folder = normFolder(raw);
            if (!folder || ids.has(folder.id)) continue; // en conflicto gana la local
            ids.add(folder.id);
            folders.push(folder);
            foldersAdded++;
        }

        const list = readFavs(storage);
        const byCod = new Map(list.map((f) => [f.codStop, f]));
        let added = 0;
        let updated = 0;
        for (const raw of data.favorites) {
            const inc = normFav(raw);
            if (!inc) continue;
            if (inc.folderId && !ids.has(inc.folderId)) delete inc.folderId;
            const cur = byCod.get(inc.codStop);
            if (!cur) {
                list.push(inc);
                byCod.set(inc.codStop, inc);
                added++;
                continue;
            }
            // Solo pisa lo presente y válido en el fichero; compare para no
            // contar como cambio un re-import idéntico.
            const before = JSON.stringify(cur);
            if (typeof raw.name === 'string' && raw.name.trim()) cur.name = raw.name.trim();
            if (inc.alias !== undefined) cur.alias = inc.alias;
            if (Number.isFinite(inc.lat)) cur.lat = inc.lat;
            if (Number.isFinite(inc.lng)) cur.lng = inc.lng;
            if (inc.folderId) cur.folderId = inc.folderId;
            if (Number.isFinite(inc.order)) cur.order = inc.order;
            if (JSON.stringify(cur) !== before) updated++;
        }

        writeJSON(FOLDERS_KEY, folders, storage);
        writeFavs(list, storage);
        const s = storageOf(storage);
        if (s && typeof data.deviceId === 'string' && data.deviceId && !s.getItem(DEVICE_KEY)) {
            try { s.setItem(DEVICE_KEY, data.deviceId); } catch { /* modo privado */ }
        }
        return { ok: true, added, updated, foldersAdded };
    } catch { return fail; }
}

const B4usStore = {
    ARRIVAL, classifyArrival, shouldFreezeStop,
    getDeviceId,
    getFolders, createFolder, renameFolder, deleteFolder,
    getFavorites, isFavorite, addFavorite, removeFavorite, toggleFavorite,
    setAlias, setFolder, reorder,
    exportJSON, importJSON,
};

if (typeof module === 'object' && module.exports) module.exports = B4usStore;

// Self-check: `node public/b4us-store.js` (los tests cubren lo mismo con node:test).
if (typeof require !== 'undefined' && require.main === module) {
    const assert = require('node:assert/strict');
    const mem = new Map();
    const s = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

    assert.equal(getDeviceId(s), getDeviceId(s));
    const folder = createFolder('Casa', null, s);
    assert.ok(folder?.id);
    assert.equal(addFavorite({ codStop: '8_1', name: 'Prueba', lat: 40.4, lng: -3.7 }, folder.id, s)?.folderId, folder.id);
    assert.equal(setAlias('8_1', '  mi parada  ', s).alias, 'mi parada');
    assert.equal(setAlias('8_1', '', s).alias, undefined);
    assert.equal(deleteFolder(folder.id, s), 1);
    assert.equal(getFavorites(null, s).length, 1);
    assert.equal(shouldFreezeStop([{ arrivalEpoch: Date.now() - 1000 }]), ARRIVAL.PAST);
    assert.equal(shouldFreezeStop([{ arrivalEpoch: Date.now() + 60000 }]), null);
    assert.equal(classifyArrival(0, true), ARRIVAL.PAST);
    assert.equal(importJSON(exportJSON(s), s).added, 0);
    assert.equal(importJSON('{no', s).ok, false);
    console.log('b4us-store: self-check OK');
}
