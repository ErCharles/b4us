# B4us — URL permanente gratis (GitHub Pages + DuckDNS/Caddy)

Dos piezas:
- **Frontend** → GitHub Pages: `https://ercharles.github.io/b4us/` (gratis, permanente).
- **Backend** → tu host de casa, expuesto en `https://b4us.duckdns.org` vía Caddy (HTTPS automático).

El frontend en Pages llama al backend en `b4us.duckdns.org` (CORS ya permitido en `config.js`).

> Requiere **port-forward de 80 y 443** en el router hacia este host. Si estás
> tras CGNAT y no puedes abrir puertos, esto NO funciona — habría que volver a
> un túnel (cloudflared) con un dominio. La IP pública no aparece en ningún
> comando: el updater usa `ip=` vacío y DuckDNS la detecta sola.

---

## A. Backend público con DuckDNS + Caddy (en el host)

1. **DuckDNS**: crea cuenta en https://www.duckdns.org y registra el subdominio
   **`b4us`** (si está pillado, elige otro y reemplaza `b4us` en `Caddyfile`,
   `duckdns-update.sh`, `public/app.js` y la CSP de `src/server.js`). Copia tu token.

2. **Token** (no lo pegues en chat ni en archivos versionados):
   ```sh
   printf '%s' '<tu-token>' > /root/.duckdns-token
   chmod 600 /root/.duckdns-token
   echo '.duckdns-token' >> /root/BUS/.gitignore
   ```

3. **Updater de IP** (cron cada 5 min; mantiene el A-record):
   ```sh
   chmod +x /root/BUS/duckdns-update.sh
   /root/BUS/duckdns-update.sh        # primera vez: debe salir sin error
   ( crontab -l 2>/dev/null; echo '*/5 * * * * /root/BUS/duckdns-update.sh' ) | crontab -
   ```

4. **Router**: port-forward TCP **80** y **443** → este host (puerto→mismo puerto).

5. **Caddy** (contenedor, red host para alcanzar :3090 y atar 80/443):
   ```sh
   docker run -d --name caddy --restart unless-stopped --network host \
     -v /root/BUS/Caddyfile:/etc/caddy/Caddyfile:ro \
     -v caddy_data:/data -v caddy_config:/config \
     caddy:2
   docker logs -f caddy        # debe obtener certificado para b4us.duckdns.org
   ```

6. **Verifica**:
   ```sh
   curl -s https://b4us.duckdns.org/ready          # {"ready":true,...}
   curl -s https://b4us.duckdns.org/api/stops/4_11/times | head -c 100
   ```

---

## B. Frontend a GitHub Pages (actualizar el build de hace 1 mes)

Pages solo se actualiza al hacer **push de `public/` a `main`** en `ercharles/b4us`.
Todo el código nuevo está en este árbol (`/root/BUS`), no en tu repo de GitHub.

Desde tu clon con auth de GitHub (o desde el host si tiene SSH key de GitHub):
```sh
# traer este árbol a tu clon si hace falta (scp/rsync desde el host), luego:
git add -A
git commit -m "feat: ETAs honestas, poller SSE compartido, seguridad, frontend; backend en b4us.duckdns.org"
git push origin main
```
El workflow `pages.yml` redepliega `public/` automáticamente. En ~1 min,
`https://ercharles.github.io/b4us/` sirve el build nuevo (el service worker
mostrará "Nueva versión — Recargar").

> Si el host `/root/BUS` no tiene remote de GitHub, añádelo (necesita tu auth):
> `git remote add origin git@github.com:ercharles/b4us.git`. Ojo: la historia
> del repo en GitHub puede diverger del commit inicial del host → quizá
> `git push --force-with-lease` tras revisar, o mejor push desde tu clon.

---

## Resultado
- `https://ercharles.github.io/b4us/` — URL permanente y gratis (frontend).
- `https://b4us.duckdns.org` — backend (y también sirve la app directamente).
Ambas funcionan; las ETAs en vivo salen cuando el backend está alcanzable.
