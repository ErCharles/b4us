'use strict';

// Check runnable del estado de cliente: carpetas, alias, orden, copia de
// seguridad y corte de sondeo. Sin frameworks: `node --test test/*.test.js`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../public/b4us-store.js');
const { ARRIVAL, classifyArrival, shouldFreezeStop, ...api } = store;

function fakeStorage(initial) {
    const mem = new Map(Object.entries(initial || {}));
    return {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: (k) => mem.delete(k),
        mem,
    };
}

const LEGACY = { codStop: '8_08554', name: 'Intercambiador', lat: 40.41, lng: -3.7 };

// --- Dispositivo ---

test('getDeviceId: estable y persistido', () => {
    const s = fakeStorage();
    const id = api.getDeviceId(s);
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(api.getDeviceId(s), id);
    assert.equal(s.getItem('b4us_device_id'), id);
});

// --- Favoritos: compatibilidad y alias ---

test('favorito legado {codStop,name,lat,lng} sigue valiendo', () => {
    const s = fakeStorage({ bus_favs: JSON.stringify([LEGACY]) });
    const [f] = api.getFavorites(undefined, s);
    assert.deepEqual(f, LEGACY);
    assert.equal(f.alias, undefined);      // alias ausente -> la UI pinta name
    assert.equal(f.folderId, undefined);   // -> carpeta implícita "Favoritos"
    assert.ok(api.isFavorite(LEGACY.codStop, s));
});

test('setAlias: recorta, y cadena vacía borra el alias', () => {
    const s = fakeStorage({ bus_favs: JSON.stringify([LEGACY]) });
    assert.equal(api.setAlias(LEGACY.codStop, '  casa  ', s).alias, 'casa');
    assert.equal(api.getFavorites(undefined, s)[0].name, 'Intercambiador'); // el oficial no se toca
    assert.equal(api.setAlias(LEGACY.codStop, '   ', s).alias, undefined);
    assert.equal(api.setAlias('nope', 'x', s), null);
    assert.equal(api.setAlias(LEGACY.codStop, 'a'.repeat(200), s).alias.length, 60);
});

test('toggleFavorite: devuelve si quedó marcada y nunca duplica', () => {
    const s = fakeStorage();
    assert.equal(api.toggleFavorite(LEGACY, s), true);
    assert.equal(api.toggleFavorite({ ...LEGACY, name: 'otra vez' }, s), false);
    assert.equal(api.addFavorite({ codStop: 'dup', name: 'a' }, null, s)?.codStop, 'dup');
    assert.equal(api.addFavorite({ codStop: 'dup', name: 'b' }, null, s), null); // ya existe
    assert.equal(api.addFavorite({ name: 'sin cod' }, null, s), null);
    assert.equal(api.getFavorites(undefined, s).length, 1);
});

// --- Carpetas ---

test('createFolder / renameFolder validan nombre', () => {
    const s = fakeStorage();
    assert.equal(api.createFolder('   ', null, s), null);
    const f = api.createFolder('  Casa  ', '#AABBCC', s);
    assert.equal(f.name, 'Casa');
    assert.equal(f.color, '#AABBCC');
    assert.equal(api.createFolder('Sin color válido', 'rojo', s).color, undefined);
    assert.equal(api.renameFolder(f.id, 'Piso', s).name, 'Piso');
    assert.equal(api.renameFolder(f.id, '', s), null);
    assert.equal(api.renameFolder('nope', 'x', s), null);
    assert.equal(api.getFolders(s).length, 2);
});

test('deleteFolder: devuelve cuántas paradas volvieron a Favoritos, sin borrarlas', () => {
    const s = fakeStorage();
    const f = api.createFolder('Casa', null, s);
    api.addFavorite({ codStop: 'a', name: 'A' }, f.id, s);
    api.addFavorite({ codStop: 'b', name: 'B' }, f.id, s);
    api.addFavorite({ codStop: 'c', name: 'C' }, null, s);

    assert.equal(api.deleteFolder(f.id, s), 2);
    assert.equal(api.getFolders(s).length, 0);
    assert.equal(api.getFavorites(undefined, s).length, 3);       // ninguna parada borrada
    assert.equal(api.getFavorites(null, s).length, 3);            // todas en la implícita
    assert.equal(api.deleteFolder(f.id, s), 0);                   // ya no existe
    assert.equal(api.getFavorites(undefined, s)[0].folderId, undefined);
});

test('setFolder mueve y getFavorites filtra por carpeta (folderId irresoluble -> implícita)', () => {
    const s = fakeStorage();
    const f = api.createFolder('Casa', null, s);
    api.addFavorite({ codStop: 'a', name: 'A' }, null, s);
    api.setFolder('a', f.id, s);
    assert.equal(api.getFavorites(f.id, s).length, 1);
    assert.equal(api.getFavorites(null, s).length, 0);
    api.setFolder('a', 'carpeta-que-no-existe', s);               // degrada a implícita
    assert.equal(api.getFavorites(f.id, s).length, 0);
    assert.equal(api.setFolder('nope', f.id, s), null);
});

test('reorder: mueve dentro de su carpeta y renumera 0..n-1', () => {
    const s = fakeStorage();
    for (const cod of ['a', 'b', 'c']) api.addFavorite({ codStop: cod, name: cod }, null, s);
    const ordered = api.reorder('c', 0, s);
    assert.deepEqual(ordered.map((f) => f.codStop), ['c', 'a', 'b']);
    assert.deepEqual(ordered.map((f) => f.order), [0, 1, 2]);
    assert.deepEqual(api.getFavorites(undefined, s).map((f) => f.codStop), ['c', 'a', 'b']);
    assert.deepEqual(api.reorder('nope', 0, s), []);
});

// --- Copia de seguridad ---

test('exportJSON -> importJSON es idempotente y hace merge por codStop', () => {
    const s = fakeStorage({ bus_favs: JSON.stringify([LEGACY]) });
    const folder = api.createFolder('Casa', null, s);
    api.addFavorite({ codStop: '8_1', name: 'Uno' }, folder.id, s);
    api.setAlias('8_1', 'mi parada', s);
    const dump = api.exportJSON(s);

    const again = api.importJSON(dump, fakeStorage({ bus_favs: JSON.stringify([LEGACY]) }));
    assert.deepEqual(again, { ok: true, added: 1, updated: 0, foldersAdded: 1 });

    // Sobre el MISMO storage: ni añade ni cambia nada.
    assert.deepEqual(api.importJSON(dump, s), { ok: true, added: 0, updated: 0, foldersAdded: 0 });

    // Merge: llega un alias nuevo para una parada existente, sin borrar lo local.
    const s2 = fakeStorage({ bus_favs: JSON.stringify([LEGACY]) });
    const res = api.importJSON(JSON.stringify({
        deviceId: 'otro-device',
        folders: [],
        favorites: [{ codStop: LEGACY.codStop, name: 'Intercambiador', alias: 'curro' }],
    }), s2);
    assert.deepEqual(res, { ok: true, added: 0, updated: 1, foldersAdded: 0 });
    const [merged] = api.getFavorites(undefined, s2);
    assert.equal(merged.alias, 'curro');
    assert.equal(merged.lat, LEGACY.lat);                       // lo local no se borra
    assert.equal(api.getDeviceId(s2), 'otro-device');           // deviceId vacío -> se rellena
});

test('importJSON nunca lanza con basura', () => {
    const s = fakeStorage({ bus_favs: JSON.stringify([LEGACY]) });
    for (const bad of ['{no', 'null', '[]', '"texto"', JSON.stringify({ favorites: [] }), undefined, '']) {
        const res = api.importJSON(bad, s);
        assert.equal(res.ok, false, `debería fallar: ${bad}`);
        assert.equal(res.added, 0);
    }
    assert.equal(api.getFavorites(undefined, s).length, 1);     // intacto
});

test('datos corruptos en localStorage -> estado vacío, sin lanzar', () => {
    const s = fakeStorage({ bus_favs: '{{rotísimo', b4us_folders_v1: 'no-json' });
    assert.deepEqual(api.getFavorites(undefined, s), []);
    assert.deepEqual(api.getFolders(s), []);
    assert.equal(api.isFavorite('x', s), false);
});

test('normaliza entradas malformadas y descarta duplicados (gana el primero)', () => {
    const s = fakeStorage({
        bus_favs: JSON.stringify([
            { codStop: 'a', name: 'A' },
            { codStop: 'a', name: 'A duplicada' },
            { codStop: 'b' },                                      // sin name -> cae al codStop
            { name: 'sin codStop' },
            null,
            { codStop: 'c', name: 'C', lat: '40.4', alias: 12 },
        ]),
    });
    const list = api.getFavorites(undefined, s);
    assert.deepEqual(list.map((f) => f.codStop), ['a', 'b', 'c']);
    assert.equal(list[0].name, 'A');
    assert.equal(list[1].name, 'b');
    assert.equal(list[2].lat, undefined);                      // '40.4' no es finito -> fuera
    assert.equal(list[2].alias, undefined);
});

// --- Corte de sondeo ---

const now = 1_700_000_000_000;
const PAST = { arrivalEpoch: now - 60_000 };
const FUTURE = { arrivalEpoch: now + 120_000 };

test('classifyArrival: OK si secondsLeft > 0', () => {
    assert.equal(classifyArrival(90, true), ARRIVAL.OK);
    assert.equal(classifyArrival(1, true), ARRIVAL.OK);
});

test('classifyArrival: YA_PASADO si secondsLeft <= 0 (el servidor lo clampea a 0)', () => {
    assert.equal(classifyArrival(0, true), ARRIVAL.PAST);
    assert.equal(classifyArrival(-5, true), ARRIVAL.PAST);
});

test('classifyArrival: SIN_HORARIO sin payload o sin epoch usable', () => {
    assert.equal(classifyArrival(90, false), ARRIVAL.NONE);
    assert.equal(classifyArrival(NaN, true), ARRIVAL.NONE);
    assert.equal(classifyArrival(undefined, true), ARRIVAL.NONE);
});

test('shouldFreezeStop: no congela si queda una llegada OK', () => {
    assert.equal(shouldFreezeStop([PAST, FUTURE], now), null);
    assert.equal(shouldFreezeStop([FUTURE], now), null);
});

test('shouldFreezeStop: congela cuando todas son terminales o no hay llegadas', () => {
    assert.equal(shouldFreezeStop([PAST, PAST], now), ARRIVAL.PAST);
    assert.equal(shouldFreezeStop(null, now), ARRIVAL.NONE);
    assert.equal(shouldFreezeStop([], now), ARRIVAL.NONE);
    assert.equal(shouldFreezeStop([{}], now), ARRIVAL.NONE);
});
