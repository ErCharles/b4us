# B4us — Documentación Completa

Plataforma web de tiempos de llegada (ETA) en tiempo real para el transporte público de Madrid (CRTM): autobuses interurbanos y EMT, metro y metro ligero, cercanías. Cobertura completa de la red metropolitana.

---

## 1. Visión general

| | |
|---|---|
| **Nombre** | `b4us` |
| **Tipo** | Proxy inverso + SSE en tiempo real + frontend SPA |
| **Backend** | Node.js 20 · Fastify 5 · Redis 7 · undici |
| **Frontend** | HTML/CSS/JS vanilla · Leaflet (mapa) · Inter (tipografía) |
| **Despliegue** | Docker Compose (backend + redis) |
| **Puerto público** | `3090` (mapeado a `3000` interno) |
| **Origen de datos** | API no documentada del CRTM (`https://www.crtm.es/widgets/api`) |

El servicio actúa como **proxy inverso** entre el navegador y la API interna del CRTM, resolviendo CORS, rate-limiting upstream, y degradación por avalancha de tráfico mediante **caché Stale-While-Revalidate (SWR)** en Redis.

---

## 2. Arquitectura

```
┌────────────────┐  HTTPS  ┌──────────────────────────────────┐  HTTPS  ┌─────────────┐
│  Navegador     │◄──────► │      Backend Fastify (Node 20)   │◄──────► │  CRTM API   │
│  (SPA + Map)   │  SSE    │  ─ /api/stops/*                  │  GET    │ widgets/api │
│  Leaflet       │         │  ─ /api/lines/*                  │ JSON    │ /GetStops…  │
│  EventSource   │         │  ─ /api/sse/stop/:cod  (push)    │         │ /GetLines…  │
└────────────────┘         │  ─ Static /public                │         └─────────────┘
                           └──────────────┬───────────────────┘
                                          │ ioredis (lazy)
                                          ▼
                                  ┌───────────────┐
                                  │   Redis 7     │
                                  │  SWR cache:   │
                                  │  data:<key>   │
                                  │  ts:<key>     │
                                  │  lock:<key>   │
                                  └───────────────┘
```

### 2.1 Flujo de una petición ETA

1. El usuario abre la app y selecciona una parada (ej. `8_08554`).
2. El frontend dispara dos canales en paralelo: `GET /api/stops/<codStop>/times` (snapshot inmediato) **y** `EventSource /api/sse/stop/<codStop>` (actualizaciones).
3. El backend ejecuta `swr("stops:times:8_08554", () => crtm.getStopTimes(...))`:
   - Si hay dato **fresco** (< `freshTtl`s) → lo devuelve.
   - Si hay dato **stale** (< `staleTtl`s) → lo devuelve **e** intenta revalidar en segundo plano (single-flight lock).
   - Si no hay dato → fetch directo a CRTM, persiste y devuelve.
4. Si Redis cae, hay un fallback `Map` en memoria con TTL fijo y eviction LRU básico (max 500 entradas).
5. La conexión SSE emite `event: update` cada `updateInterval` ms (5 s por defecto) y `: heartbeat` cada `heartbeatInterval` ms (15 s).

---

## 3. Stack y dependencias

### Backend (`package.json`)

```json
"dependencies": {
  "fastify": "^5.2.1",
  "@fastify/cors": "^11.0.0",
  "@fastify/rate-limit": "^10.2.0",
  "@fastify/static": "^9.1.3",
  "@fastify/compress": "^8.0.0",
  "@fastify/etag": "^6.0.0",
  "fastify-metrics": "^12.1.0",
  "ioredis": "^5.4.2",
  "undici": "^7.18.0"
}
```

| Paquete | Rol |
|---|---|
| `fastify` | Servidor HTTP de alto rendimiento con compilación JIT de schemas. |
| `@fastify/cors` | CORS abierto (`origin: true`, sólo `GET`/`OPTIONS`). |
| `@fastify/rate-limit` | 100 req/min por IP por defecto. |
| `@fastify/static` | Sirve `public/` en `/`. (v9: corrige path-traversal y route-guard bypass). |
| `@fastify/compress` | Brotli + gzip para respuestas ≥ 1 KB. SSE deshabilitado vía `config.compress=false`. |
| `@fastify/etag` | Weak ETag (FNV) sobre respuestas JSON/HTML para 304 free. |
| `fastify-metrics` | Endpoint `/metrics` con histogramas/counters por ruta + métricas custom (SWR, breaker, SSE). |
| `ioredis` | Cliente Redis con reintentos y `lazyConnect`. |
| `undici` | HTTP/1.1 client moderno y rápido para llamar al CRTM. |

### Frontend (CDN)

- **Leaflet 1.9.4** — mapa con tiles `cartocdn.com/dark_all` (sólo desktop).
- **Inter** (Google Fonts) — tipografía.
- Sin framework: vanilla JS + DOM API + `EventSource`.

---

## 4. Estructura de ficheros

```
BUS/
├── Backend para ETA autobuses interurbanos.txt  ← Documento de diseño original (ES)
├── compass_artifact_…_text_markdown.md          ← Informe técnico de mejoras (ES)
├── Dockerfile                                    ← Node 20 alpine, EXPOSE 3000
├── docker-compose.yml                            ← Stack: backend + redis + prometheus + grafana
├── .dockerignore                                 ← Excluye node_modules, tests, .git, secrets
├── package.json                                  ← Deps + scripts (start, dev, test, test:cov)
├── package-lock.json
├── monitoring/
│   ├── prometheus.yml                            ← Scrape config (job → backend:3000/metrics)
│   └── grafana/
│       ├── provisioning/
│       │   ├── datasources/prometheus.yml        ← Auto-configura Prometheus como datasource
│       │   └── dashboards/default.yml            ← Provider que carga JSONs en dashboards/
│       └── dashboards/
│           └── bus-overview.json                 ← Dashboard de overview (HTTP, breaker, SWR, SSE)
├── public/
│   ├── index.html                                ← Shell SPA + manifest + ARIA + disclaimer
│   ├── index.css                                 ← Tema dark + estilos para favs ETA + sheet + footer
│   ├── app.js                                    ← Búsqueda, SSE reconnecting, deep links, PWA
│   ├── privacy.html                              ← Aviso legal "no oficial" + RGPD
│   ├── manifest.webmanifest                      ← PWA: standalone, icons, shortcuts
│   ├── sw.js                                     ← Service Worker (shell + SWR runtime cache)
│   └── icons/
│       ├── icon-192.svg                          ← Maskable
│       └── icon-512.svg                          ← Maskable
├── src/
│   ├── server.js                                 ← Bootstrapping (compress, etag, metrics, rutas)
│   ├── config.js                                 ← Lectura env + defaults (incl. negativeTtl)
│   ├── cache.js                                  ← SWR + single-flight + negative + stale-fallback
│   ├── crtm-client.js                            ← Undici + circuit-breaker + métricas latencia
│   ├── circuit-breaker.js                        ← Implementación propia (consecutivos)
│   ├── metrics.js                                ← Registro custom de prom-client metrics
│   ├── logger.js                                 ← Shim Pino con fallback a console (para tests)
│   └── routes/
│       ├── stops.js                              ← /api/stops/* + schemas estrictos
│       ├── lines.js                              ← /api/lines/* + schemas estrictos
│       └── sse.js                                ← /api/sse/stop/:codStop con retry+id
└── test/
    ├── circuit-breaker.test.js                   ← node:test del breaker
    ├── normalizers.test.js                       ← Edge cases de normalizadores
    ├── handlers.test.js                          ← app.inject() con stubs de crtm-client/cache
    ├── cache.test.js                             ← Memory fallback path
    └── crtm-client.test.js                       ← undici MockAgent contra widgets/api
```

---

## 5. Configuración (variables de entorno)

Definidas en `src/config.js`. Los valores entre paréntesis son los defaults; los del compose se especifican aparte.

| Variable | Default código | Default `docker-compose.yml` | Descripción |
|---|---|---|---|
| `PORT` | `3000` | `3000` | Puerto interno HTTP. |
| `REDIS_URL` | `redis://localhost:6379` | `redis://redis:6379` | Conexión Redis. |
| `CRTM_BASE_URL` | `https://www.crtm.es/widgets/api` | mismo | Base de la API upstream. |
| `CRTM_TIMEOUT` | `8000` ms | — | Timeout headers + body. |
| `CRTM_RETRIES` | `2` | — | Reintentos con backoff lineal (500 ms × intento). En `429`: backoff exponencial 1s → 5s. |
| `CACHE_FRESH_TTL` | `5` s | `15` s | Ventana "fresca" (devuelve sin revalidar). |
| `CACHE_STALE_TTL` | `60` s | `120` s | Ventana "stale" (devuelve y revalida en background). |
| `CACHE_LOCK_TTL` | `3` s | — | TTL del mutex single-flight. |
| `CACHE_NEGATIVE_TTL` | `30` s | `30` s | Cache de errores upstream (`err:<key>`) — corta el hammering. |
| `RATE_LIMIT_MAX` | `100` | — | Peticiones por minuto y por IP. |
| `LOG_LEVEL` | `info` | — | Nivel de Pino (`trace`/`debug`/`info`/`warn`/`error`). |
| `GRAFANA_PASSWORD` | — | `changeme` | Contraseña admin de Grafana (cámbiala en producción). |

User-Agent enviado al CRTM (hard-coded en `config.js`):
```
Madrid Transport/3.8.2 (Android 14; SDK 34)
```

Códigos de modo de transporte CRTM (constante `config.modes`):
- `4` = Metro
- `5` = Cercanías
- `6` = EMT (Madrid capital)
- `8` = **Interurbano** (este proyecto)
- `10` = Metro Ligero

---

## 6. Endpoints HTTP

Base URL local: `http://localhost:3090`

### 6.0 Páginas y observabilidad

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/` | SPA shell. |
| GET | `/stop/:codStop` | Deep link (sirve el mismo shell; el cliente carga la parada). Pattern `^\d+_\d+$`. |
| GET | `/privacy` | Aviso legal "no oficial" + privacidad. |
| GET | `/manifest.webmanifest` | Manifest PWA. |
| GET | `/sw.js` | Service worker. |
| GET | `/icons/icon-{192,512}.svg` | Iconos maskable. |
| GET | `/metrics` | Endpoint Prometheus (HTTP por ruta + custom). |

### 6.1 Health

`GET /health` → estado del proceso y conexión Redis.
```json
{
  "status": "healthy",
  "redis": true,
  "uptime": 73298.81,
  "memory": { "rss": 73060352, "heapTotal": 22855680, "heapUsed": 22102176, ... },
  "connections": 0
}
```
Devuelve `"status": "degraded"` si Redis no responde a `PING`.

### 6.2 Paradas (`src/routes/stops.js`)

| Método | Ruta | Parámetros | Cache key |
|---|---|---|---|
| GET | `/api/stops/search?q=<texto>` | `q` ≥ 2 chars | `stops:search:<q>` |
| GET | `/api/stops/:codStop` | path | `stops:info:<codStop>` |
| GET | `/api/stops/:codStop/times` | path | `stops:times:<codStop>` |
| GET | `/api/stops/nearby?lat&lng&radius` | `radius` default 500 m | `stops:nearby:<lat>_<lng>_<r>` |
| GET | `/api/stops/municipality/:codMunicipality` | path | `stops:muni:<cod>` |
| GET | `/api/stops/postcode/:postcode` | path | `stops:postcode:<cp>` |

**Formato de respuesta `/api/stops/:codStop/times`** (normalizado por `normalizeStopTimes`):
```json
{
  "codStop": "8_08554",
  "stopName": "AV.ONU-PARQUE LEVANTE",
  "arrivals": [
    {
      "line": "521",
      "lineCode": "8__521___",
      "lineName": "521-MADRID (Cuatro Vientos)-MÓSTOLES",
      "destination": "MÓSTOLES (Pol. Ind. Arroyomolinos)-MADRID (Cuatro Vientos)",
      "direction": 2,
      "secondsLeft": 90,
      "minutesLeft": 1,
      "secs": 30,
      "arrivalTime": "2026-05-07T20:42:13+02:00",
      "arrivalEpoch": 1778179333000,
      "codVehicle": null,
      "isNight": false,
      "color": "#8EBF42",
      "company": ""
    }
  ],
  "lineStatuses": {
    "8__521___": { "saeActive": true, "lineName": "521" }
  },
  "serverTime": "...",
  "serverEpoch": 1778179242693,
  "timestamp": 1778179242693
}
```
- `secondsLeft` está calculado en el servidor con su reloj; el frontend lo recompone con un delta cliente↔servidor suavizado para evitar saltos.
- `lineStatuses[lineCode].saeActive = true` ⇒ tracking GPS en vivo (badge verde "● GPS"). `false` ⇒ horario teórico (badge gris "◦ Horario").

### 6.3 Líneas (`src/routes/lines.js`)

| Método | Ruta | Notas |
|---|---|---|
| GET | `/api/lines?mode=8&municipality=<cod>` | Default `mode=8` (interurbano). Si hay municipality, se anexa al CRTM. |
| GET | `/api/lines/:codLine` | Info detallada (itinerarios, tipos). |
| GET | `/api/lines/:codLine/location?mode&itinerary&stop&direction` | Ubicación de vehículos (devuelve lo crudo del CRTM). |
| GET | `/api/lines/:codLine/incidents?mode=8` | Incidencias activas. |
| GET | `/api/lines/:codLine/timeplanning` | Cuadro horario teórico. |

### 6.4 SSE (`src/routes/sse.js`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/sse/stop/:codStop` | Stream `text/event-stream`. |
| GET | `/api/sse/stats` | `{ totalConnections, byStop }` (interno). |

**Protocolo SSE:**
- `event: update\ndata: <JSON normalizado igual que /times>\n\n` cada `updateInterval` (5 s).
- `event: error\ndata: { message, codStop }\n\n` si una actualización falla.
- `: heartbeat\n\n` (comentario SSE, ignorado por el cliente) cada `heartbeatInterval` (15 s).
- `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` (deshabilita buffering en NGINX), `Connection: keep-alive`.
- Cleanup explícito en `req.raw.on('close'|'error')`: limpia ambos timers y borra la conexión del `Map`.

---

## 7. Caché Stale-While-Revalidate (`src/cache.js`)

Tres claves Redis por entrada lógica:
- `data:<key>` → JSON serializado (TTL = `STALE × 2`).
- `ts:<key>` → epoch ms del último `set` (TTL igual).
- `lock:<key>` → mutex `NX PX` para single-flight.

```
┌──────────────────────────────────────────────────────────────────┐
│ swr(key, fetchFn)                                                │
│                                                                  │
│  age = (now - ts) / 1000                                         │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ age < FRESH        → return cached                        │   │
│  │ age < STALE        → return cached + lock NX PX           │   │
│  │                       └ if acquired: revalidate background│   │
│  │ age ≥ STALE / miss → lock NX PX                           │   │
│  │                       ├ acquired → fetch + persist        │   │
│  │                       └ not acq.  → wait 800ms, retry GET │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  on Redis error / status != ready → fallback Map en memoria      │
└──────────────────────────────────────────────────────────────────┘
```

**Garantías:**
- En una avalancha de N peticiones a la misma key, sólo **una** sale al CRTM por ventana de revalidación (gracias al lock).
- Si Redis se desconecta, el sistema sigue sirviendo desde memoria (consistencia local débil pero disponibilidad alta).
- Los datos `stale` se sirven mientras la revalidación corre en background → latencia percibida de sub-ms aunque la API upstream tarde.

---

## 8. Frontend (`public/`)

### `index.html`
Shell mobile-first con:
- **Topbar** (logo + status de conexión + botón "cerca de mí").
- **Search bar** (debounce 300 ms, ≥ 2 chars).
- **Sección Favoritos** (persistencia en `localStorage` clave `bus_favs`).
- **Panel ETA** (cabecera + lista de llegadas + footer de timestamp).
- **Mapa Leaflet** sólo en desktop (`window.innerWidth > 768`); en móvil queda oculto y expandible.
- **Toast de incidencias** (`#incident-banner`).

### `app.js` — capa cliente

Estado global (objeto `state`):
```
currentStop · eventSource · favorites · markers · countdownTimer
serverTimeDelta · mapExpanded · lastEpochs · lineStatuses
```

Comportamientos clave:
- **Doble-fetch al seleccionar parada**: snapshot HTTP + SSE en paralelo, para pintar al instante sin esperar al primer evento SSE.
- **Sincronización de reloj**: cada `update` calcula `delta = Date.now() - serverEpoch` y aplica EMA `0.7·prev + 0.3·new` para evitar saltos por jitter de red.
- **Suavizado de epochs**: si la diferencia entre el nuevo `arrivalEpoch` y el anterior para misma `(lineCode, direction, codIssue)` es < 60 s, mezcla `0.8·new + 0.2·old`. Evita parpadeos visuales en la cuenta atrás.
- **Agrupación**: por `line:direction`, máximo 2 buses por grupo (próximo + siguiente).
- **Estados visuales del countdown**:
  - `sec === 0` → `⟶`, clase `imminent`, etiqueta "EN PARADA".
  - `sec < 60` → `0:SS`, clase `imminent`, etiqueta "segundos".
  - `m ≤ 3` → `M:SS`, clase `arriving`.
  - resto → `M:SS`, clase `normal`.
- **Geolocalización**: `navigator.geolocation.getCurrentPosition` con `enableHighAccuracy`, marca punto azul en el mapa y consulta `/api/stops/nearby` con radio 600 m.
- **Cache warm-up**: al cargar favoritos, hace `fetch(/times, {cache:'no-store'})` en background para cada uno → SWR los precalienta sin esperar al click.
- **XSS prevention**: helper `esc()` (textContent → innerHTML) usado en todos los renders dinámicos.

### `index.css`
Diseño dark con paleta verde CRTM (`--accent: #8EBF42`). Tokens CSS en `:root`. Soporta `safe-area-inset-bottom` para iPhone.

---

## 9. Cliente CRTM (`src/crtm-client.js`)

### Endpoints upstream usados

| Función exportada | Endpoint CRTM |
|---|---|
| `searchStops(q)` | `GET /GetStops.php?customSearch=<q>` |
| `getStopInfo(cod)` | `GET /GetStops.php?codStop=<cod>` |
| `getStopsByMunicipality(cod)` | `GET /GetStops.php?codMunicipality=<cod>` |
| `getStopsByPostCode(cp)` | `GET /GetStops.php?postcode=<cp>` |
| `getNearestStops(lat,lng,d)` | `GET /GetNearestStopsByLocation.php?latitude=&longitude=&mode=&method=2&precision=<d>` |
| `getStopTimes(cod)` | `GET /GetStopsTimes.php?codStop=<cod>&type=0&orderBy=2&stopTimesByIti=<cod>` |
| `getLinesByMode(m)` | `GET /GetLines.php?mode=<m>` |
| `getLinesByMunicipality(cod,m)` | `GET /GetLines.php?codMunicipality=<cod>&mode=<m>` |
| `getLineInfo(cod)` | `GET /GetLinesInformation.php?activeItinerary=1&codLine=<cod>` |
| `getLineLocation(...)` | `GET /GetLineLocation.php?...` |
| `getIncidents(m,cod)` | `GET /GetIncidentsAffectations.php?mode=<m>&codLine=<cod>` |
| `getLinesTimeplanning(cod)` | `GET /GetLinesTimePlanning.php?activeItinerary=1&codLine=<cod>` |

### Cabeceras enviadas
```
User-Agent: Madrid Transport/3.8.2 (Android 14; SDK 34)
Accept: application/json, text/plain, */*
Accept-Language: es-ES,es;q=0.9
Referer: https://www.crtm.es/
Origin: https://www.crtm.es
```

### Errores detectados y mapeados a excepción
- `statusCode === 429` → backoff exponencial `min(1000 × 2^attempt, 5000)` y reintenta hasta `MAX_RETRIES`.
- `2xx` con cuerpo `{ faultcode | faultstring }` → `CRTM Fault: ...`.
- `2xx` con `errorCode != "0"` → `CRTM API Error: <errorMessage>`.
- `2xx` con `error` en raíz → `CRTM API Error: <error>`.
- Body no parseable como JSON → `Invalid JSON from CRTM: <preview>`.
- Cualquier `4xx`/`5xx` → reintenta con `setTimeout(500*(attempt+1))` hasta agotar `retries`.

### Codificadores helpers
- `lineCode(mode, line)` → `"<mode>__<line>___"` (ej. `8__521___`).
- `stopCode(mode, stop)` → `"<mode>_<stop>"` (ej. `8_08554`).

---

## 10. Despliegue

### 10.1 Docker Compose (recomendado)

```bash
cd /root/BUS
docker compose up -d --build
docker compose ps          # ambos contenedores deben estar "(healthy)"
docker compose logs -f backend
```

Servicios definidos:
- `backend` (`bus-backend`): build local, expone `3090:3000`, healthcheck HTTP a `/health` cada 30 s, monta `./:/app` con volumen anónimo `/app/node_modules` (los `node_modules` del host no contaminan).
- `redis` (`bus-redis`): `redis:7-alpine`, persistencia AOF, `maxmemory 128mb`, política `allkeys-lru`. **No expone puerto al host** (sólo accesible vía red de compose).
- `prometheus` (`bus-prometheus`): `prom/prometheus`, scrapea `backend:3000/metrics` cada 15 s, retención 15 días, **bind sólo a `127.0.0.1:9090`**.
- `grafana` (`bus-grafana`): `grafana/grafana-oss`, datasource Prometheus + dashboard "B4us Overview" auto-provisionados, **bind sólo a `127.0.0.1:3091`**. Login admin/`$GRAFANA_PASSWORD` (default `changeme` — sustituye en `.env`).

Volúmenes persistentes: `redis_data`, `prometheus_data`, `grafana_data`.

> Para acceso remoto, expón Grafana detrás del mismo reverse proxy que la app (Caddy/Nginx) con su propia auth. **No publiques `/metrics` sin protección** — incluye serverside breakdowns que ayudan a un atacante a perfilar fallos del upstream.

### 10.2 Bare-metal Node.js

```bash
cd /root/BUS
npm ci --omit=dev          # o npm install
REDIS_URL=redis://localhost:6379 PORT=3000 npm start
# o con auto-reload en desarrollo:
npm run dev                # node --watch src/server.js
```
Si no hay Redis, el backend arranca y degrada a caché en memoria con `[Redis] ... ECONNREFUSED` en stderr.

### 10.3 Verificación rápida

```bash
curl http://localhost:3090/health
curl 'http://localhost:3090/api/stops/8_08554/times' | jq .
curl -N 'http://localhost:3090/api/sse/stop/8_08554'   # Ctrl-C para salir
```

---

## 11. Pruebas en este entorno (estado actual)

Verificado el **2026-05-07**:

| Endpoint | Estado | Notas |
|---|---|---|
| `GET /health` | ✅ | `redis: true`, uptime ~20 h. |
| `GET /api/stops/8_08554/times` | ✅ | Devuelve líneas 521, 523 con ETAs reales. |
| `GET /api/sse/stop/8_08554` | ✅ | Stream SSE recibe `event: update` con datos válidos. |
| `GET /api/sse/stats` | ✅ | `{totalConnections:0,byStop:{}}`. |
| `GET /api/stops/search?q=...` | ⚠️ | CRTM responde `500` upstream (no es bug del proxy). |
| `GET /api/lines?mode=8` | ⚠️ | Igual: CRTM `500`. |
| `GET /api/stops/nearby` | ⚠️ | Timeout en CRTM. |
| Frontend `/` | ✅ | HTML servido con headers de rate-limit visibles. |

**Conclusión**: el proxy y la caché funcionan. La inestabilidad observada es del upstream (`widgets/api/GetStops.php?customSearch=...` y `GetLines.php` están devolviendo 500 hoy). Las paradas concretas por código y SSE funcionan, que es el flujo principal de uso.

Estado de la caché Redis durante las pruebas:
```
DBSIZE: 2
KEYS: ts:stops:times:8_08554, data:stops:times:8_08554
TTL data:...: 138 s   (STALE_TTL=120 × 2 = 240; se renovó hace ~100 s)
```

---

## 12. Códigos de transporte y paradas conocidas

Códigos CRTM relevantes:
- **Modo 4** = metro · **Modo 5** = cercanías · **Modo 6** = EMT · **Modo 8** = interurbano · **Modo 10** = metro ligero.
- **Líneas interurbanas del corredor Madrid–suroeste (Príncipe Pío / Cuatro Vientos)**: 521, 522, 523, 524, 525, 526, 527, 528, 528A, 529.
- **Búhos**: N501, N504 (los detecta `isNight` y se renderizan con etiqueta 🌙).

Formato de `codStop`: `<mode>_<numero>` (ej. `8_08554` = "AV.ONU-PARQUE LEVANTE").

Paleta de colores por línea (en `lineColorMap` de `routes/stops.js` y `COLORS` en `app.js`):
```
521 #8EBF42  522 #E74C3C  523 #3498DB  524 #F39C12
525 #9B59B6  526 #1ABC9C  527 #E67E22  528 #2ECC71
529 #E91E63  510 #00BCD4  518 #FF5722  520 #795548
551 #607D8B  581 #4CAF50  528A #CDDC39
N501 #6366F1 N504 #7C3AED
```

---

## 13. Decisiones arquitectónicas (resumen del documento de diseño)

1. **Proxy inverso obligatorio** — peticiones directas del navegador al CRTM rompen por CORS y por rate-limiting upstream.
2. **Node.js + Fastify** sobre alternativas (Python/FastAPI, PHP/Swoole) — bucle de eventos óptimo para I/O bound, ecosistema maduro de SSE y gran rendimiento (~20 K RPS de Fastify).
3. **Redis con SWR + single-flight** sobre cache-aside con TTL estricto — evita "cache stampede" cuando muchos usuarios consultan la misma parada en hora punta.
4. **SSE sobre WebSockets** — la comunicación es estrictamente unidireccional (servidor → cliente), HTTP estándar atraviesa cualquier proxy/firewall, reconexión automática nativa via `EventSource`, sin overhead de negociación binaria.

---

## 14. Operativa y observabilidad

- **Logs**: Pino (incluido en Fastify) en `level: info` (override con `LOG_LEVEL`), formato JSON con `reqId`, `responseTime`, `req/res` por request. Visibles vía `docker compose logs backend`.
  - Cada log de error o aviso lleva un `kind`: `upstream` para problemas del CRTM, `app` para problemas locales/validación. Filtra en Loki/Grafana con `{kind="upstream"}` para cuadros del proveedor.
- **Métricas**: Prometheus expone `/metrics`. Scrape cada 15 s desde el contenedor `prometheus`. Métricas custom relevantes:
  - `swr_cache_events_total{state}` — cuenta hits por estado (`fresh`, `stale`, `miss`, `stale_fallback`, `memory`).
  - `crtm_upstream_errors_total{endpoint,status}` — errores upstream con la cardinalidad acotada al `*.php`.
  - `crtm_upstream_latency_seconds_bucket{endpoint,status}` — histograma para sacar p50/p95/p99 con `histogram_quantile`.
  - `crtm_circuit_state` — `0=closed`, `1=half-open`, `2=open`.
  - `sse_connections_active{stop}` — gauge por parada (cardinalidad limitada a paradas con sub).
  - `sse_connections_opened_total` — counter agregado.
- **Dashboard**: Grafana en `http://localhost:3091` ("B4us Overview" pre-cargado). Paneles: HTTP req rate por ruta, latencia p95, estado del breaker, errores upstream, conexiones SSE, eventos SWR, latencia upstream, RSS de proceso, lag de event loop.
- **Healthcheck**: el contenedor backend usa `node -e "http.get('http://localhost:3000/health'...)"` cada 30 s. La respuesta incluye `crtmBreaker: { state, failures, openedAt }`.
- **Rate limit**: 100 req/min/IP. Headers `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` en cada respuesta.
- **CORS**: abierto (`origin: true`) sólo para `GET`/`OPTIONS`, `maxAge: 86400`.
- **Graceful shutdown**: `SIGTERM`/`SIGINT` → `fastify.close()` + `redis.quit()` + `process.exit(0)`.
- **Trust proxy**: activo (Fastify lee `X-Forwarded-*`), apto para colocar tras NGINX/Cloudflare.

---

## 15. Mejoras implementadas (v1.1.0) y pendientes

### Implementadas (esta versión)

A partir del informe técnico [`compass_artifact_…_text_markdown.md`](./compass_artifact_wf-fcd99c56-b425-4536-8341-b4d7914e19ff_text_markdown.md):

| # | Mejora | Dónde |
|---|---|---|
| 1 | **Logging diferenciado** `kind: upstream | app` (Pino) | `src/logger.js`, `src/server.js`, `src/crtm-client.js` |
| 2 | **Circuit-breaker** consecutivo + **negative caching** (`err:<key>`, 30 s) + **stale-fallback** | `src/circuit-breaker.js`, `src/cache.js`, `src/crtm-client.js` |
| 3 | **Validación estricta** (regex en codStop, postcode, lat/lng, codLine) | `src/routes/*.js` schemas |
| 4 | **Prometheus metrics** (HTTP por ruta + custom: SWR events, CRTM errors+latency, breaker state, SSE conns) | `src/metrics.js` + `fastify-metrics` |
| 5 | **Brotli + ETag + Cache-Control** (`@fastify/compress`, `@fastify/etag`, headers SWR/stale-if-error) | `src/server.js`, `src/routes/*.js` |
| 6 | **SSE robusto**: directiva `retry: 5000`, `id:` por evento, soporte `Last-Event-ID` | `src/routes/sse.js` |
| 7 | **Reconnecting EventSource** con backoff exponencial (cap 30 s, jitter ±20 %) en cliente | `public/app.js` |
| 8 | **PWA**: manifest + service worker (cache-first shell, network-first stable APIs, bypass live ETA/SSE), iconos maskable, prompt de instalación, banner de update | `public/manifest.webmanifest`, `public/sw.js`, `public/app.js`, `public/icons/*` |
| 9 | **Dashboard multi-parada de favoritos** con countdowns en vivo (Promise.all + tick compartido) | `public/app.js` (`refreshFavoritesETA`) |
| 10 | **Vibración + ding** al `EN PARADA` (preferencias en localStorage, accionables en el sheet de prefs) | `public/app.js` (`maybeNotifyArrival`, `playDing`) |
| 11 | **Deep links** `/stop/:codStop` (server hace SPA-fallback al index, cliente usa `history.pushState` y `popstate`, Web Share API) | `src/server.js`, `public/app.js` |
| 12 | **Aviso "no oficial" + página de privacidad** (`/privacy`) + footer discreto | `public/privacy.html`, `public/index.html` |
| 13 | **Accesibilidad**: `aria-live`, `role="status"`, `aria-pressed`, foco-keyboard (Esc cierra paneles), labels explícitas | `public/index.html`, `public/app.js` |
| 14 | **Tests** con `node:test` (34 casos): breaker, normalizadores, handlers `app.inject()`, swr fallback, undici `MockAgent` | `test/*.test.js` |
| 15 | **Stack de observabilidad** Prometheus + Grafana en el mismo Compose con datasource y dashboard auto-provisionados | `docker-compose.yml`, `monitoring/*` |

### Comportamientos nuevos a tener presentes

- **Endpoint `/metrics`** expuesto sin autenticación — bind sólo localhost en `docker-compose` o protege con tu reverse proxy si lo expones.
- **Endpoint `/privacy`** servido como HTML estático.
- **Endpoint `/stop/:codStop`** devuelve el shell de la SPA (no JSON) — son deep links humanos compartibles.
- **Errores upstream** se mapean ahora a **502** (CRTM 5xx) o **503** + `Retry-After: 15` (breaker abierto). Antes daban 500 indistintos.
- **Headers de error de validación** son ahora `400` con `details` estructurados (`Ajv` schemaPath/keyword), no genéricos.
- **`/health` añade** `crtmBreaker: { state, failures, openedAt }`.
- **Cliente Redis** ya no bloquea el `/health` — race contra timeout de 1 s.

### Pendientes para futuras iteraciones (del compass artifact)

- **Push notifications** "tu bus en 2 min" con VAPID + suscripciones en Redis (1–2 días de trabajo).
- **NTP-light de reloj** con `performance.now()` y mediana de offsets (mejora micro pero medible en 4G con jitter).
- **Live location del bus en mapa** (endpoint ya disponible: `/api/lines/:codLine/location`).
- **Persistencia de favoritos lado servidor** (hoy 100 % `localStorage`).
- **Bubblewrap → Google Play TWA** cuando haya >200 DAU.
- **Capa de abstracción del cliente CRTM** lista para migrar a GTFS-Realtime si CRTM lo publica.
- **i18n es/en** — descartado en quick-win (audiencia hoy es España); reevaluar al expandir cobertura.
- **Mapa estático SVG** móvil — sólo si analíticas demuestran demanda.

---

## 16. Glosario

- **CRTM** — Consorcio Regional de Transportes de Madrid.
- **SAE** — Sistema de Ayuda a la Explotación. Cuando `saeActive: true`, el ETA proviene de GPS en vivo del vehículo; si no, es un cálculo basado en horario teórico.
- **ETA** — Estimated Time of Arrival.
- **SWR** — Stale-While-Revalidate. RFC 5861.
- **SSE** — Server-Sent Events. Especificación HTML5, `text/event-stream`.
- **CITRAM** — Centro de Innovación y Gestión del Transporte Público (sistema central del CRTM).
