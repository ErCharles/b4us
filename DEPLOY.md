# B4us — Deployment & Operations

Self-hosted on a home host behind a `cloudflared` tunnel. The backend listens on
`:3090` (host) → `:3000` (container). Prometheus and Grafana are bound to
`127.0.0.1` only and are reached via the reverse proxy / tunnel, never `0.0.0.0`.

---

## 0. Security follow-ups (do these first)

### Rotate the burned /metrics token
The previous bearer token for `/metrics` (`23f8cf2d…`) was committed to git and
is therefore **compromised**. It must be rotated:

1. Generate a new token (do **not** paste it into any tracked file):
   ```sh
   openssl rand -hex 16
   ```
2. Give it to the backend via `METRICS_TOKEN` — set it in your `.env`
   (gitignored) so compose interpolates it. There is **no default** anymore;
   `docker compose up` fails fast if it is missing:
   ```
   METRICS_TOKEN=<new-token>
   ```
3. Give the *same* value to Prometheus. It is read from a file, not the tracked
   config:
   ```sh
   printf '%s' "$METRICS_TOKEN" > monitoring/metrics-token   # no trailing newline
   ```
   Then add `monitoring/metrics-token` to `.gitignore` (it is **not** committed).
4. `docker compose up -d --force-recreate backend prometheus`.

After rotating, scrub the old value from git history if the repo is shared
(e.g. `git filter-repo`) — rotation alone does not un-leak the old token.

### Kill the stray backend process on the prod host (192.168.8.226)
There is a loose `node src/server.js` process (**PID 1061**) running on the host
*in addition to* the `bus-backend` container on `:3090`. Two servers, one
codebase, no image guarantees — the container must be the single source of
truth.

> Do this on the host yourself; it is intentionally **not** automated here.

1. Confirm what is listening / what the PID is:
   ```sh
   ss -ltnp | grep -E ':3000|:3090'
   ps -fp 1061
   ```
2. Make sure the stray one is the host process, not the container's, then stop it:
   ```sh
   kill 1061        # SIGTERM (graceful); escalate to -9 only if it hangs
   ```
3. Verify only the container remains:
   ```sh
   docker ps --filter name=bus-backend
   ss -ltnp | grep ':3090'
   ```

### Dead file: `src/sae-fallback.js`
`src/sae-fallback.js` was **untracked** in git and is no longer `require`d by any
code path. It ships into the image via `COPY . .` for no reason. Remove it from
the working tree (and confirm nothing imports it) — code changes are out of scope
for this platform pass, so it is only flagged here.

---

## 1. Deploy from the image (immutable, rollback-able)

The backend no longer bind-mounts the source tree (`./:/app` was removed). It
runs **only** from the image built by the `Dockerfile`, so what runs is exactly
what was built — and rollback is redeploying a previous image.

```sh
# from the repo root, with .env present (METRICS_TOKEN, GRAFANA_PASSWORD, …)
docker compose build backend
docker compose up -d
```

Useful checks:
```sh
docker compose ps
docker inspect --format '{{.State.Health.Status}}' bus-backend   # -> healthy
docker compose logs -f backend
```

### Rollback
Tag images per release and pin the running tag, e.g.:
```sh
docker compose build backend
docker tag b4us-backend:latest b4us-backend:$(date +%Y%m%d-%H%M)
# to roll back: re-tag the previous image as the one compose runs, then `up -d`
```

---

## 2. What this hardening pass changed

- **Dockerfile**: runs as the unprivileged `node` user; base image pinned by
  multi-arch digest (`node:20-alpine@sha256:fb4cd12c…`).
- **backend service**: `read_only: true` + `tmpfs: /tmp`, `cap_drop: [ALL]`,
  `no-new-privileges`, `restart: unless-stopped`. The app only *reads* from
  `/app` and writes nothing to disk, so a read-only rootfs is safe.
- **Healthcheck → `/ready`**: the container is only reported `healthy` when it
  can actually serve. `/ready` must return **503** when Redis or the CRTM
  circuit-breaker is unhealthy, **200** otherwise.
  > Action required in `src/`: `/ready` does not exist yet — only `/health`
  > (which is informational and always 200). Add a `GET /ready` route that
  > returns 503 on `redis !== ready` or breaker open. Until then the
  > healthcheck will report `unhealthy`. (src/ is out of scope for this pass.)
- **Resource limits** (`deploy.resources.limits`): backend 384M, prometheus
  512M, grafana 256M, redis 192M.
  > These are honored by `docker compose up` (v2 CLI, non-swarm). If you deploy
  > with plain `docker run` or an old compose, translate them to `--memory` /
  > `mem_limit`.
- **METRICS_TOKEN**: no literal default — deploy fails fast if unset.

---

## 3. Alerting

`monitoring/alerts.yml` defines Prometheus rules (wired via `rule_files` in
`prometheus.yml`):

| Alert | Condition | For |
|---|---|---|
| `CRTMCircuitOpen` | `crtm_circuit_state == 2` | 2m |
| `BackendDown` | `up{job="bus-backend"} == 0` | 1m |
| `EventLoopLagHigh` | `nodejs_eventloop_lag_seconds > 0.2` | 5m |
| `HTTPLatencyP95High` | p95 of `http_request_duration_seconds` > 1s | 5m |
| `CRTMUpstreamErrorsHigh` | `rate(crtm_upstream_errors_total[5m]) > 0.2` | 5m |

There is **no Alertmanager** in this stack. The rules are visible in the
Prometheus UI (Status → Rules / Alerts), but to get *notified* configure
**Grafana alerting**: create a contact point (Telegram or a webhook) under
Alerting → Contact points, then either re-create these as Grafana-managed alert
rules against the Prometheus datasource, or add Alertmanager later and point
Prometheus at it.

---

## 4. CI

- `.github/workflows/security.yml`: `npm audit --omit=dev` (report-only) + Trivy
  fs scan (report-only) on push/PR/weekly.
- `.github/dependabot.yml`: weekly npm + github-actions update PRs.
- `.github/workflows/pages.yml`: unchanged; deploys `public/` to GitHub Pages.
