# B4us

Tiempos de llegada en tiempo real del transporte público de Madrid (CRTM): autobús, metro y cercanías. PWA sin login, sin cuentas y sin seguimiento.

- App (GitHub Pages): https://ercharles.github.io/b4us/
- API pública (servidor propio): https://b4us.pigeon-cobia.ts.net
- Privacidad y aviso legal: https://ercharles.github.io/b4us/privacy.html

## Qué es

B4us consulta las fuentes públicas del Consorcio Regional de Transportes de Madrid (CRTM) y muestra los próximos pasos de tus paradas favoritas, con estado de línea e incidentes. Los favoritos se guardan solo en tu navegador (`localStorage`): no hay registro, no hay email, no hay cuentas.

## Proyecto no oficial

B4us es un proyecto independiente y sin ánimo de lucro. **No está afiliado, patrocinado ni respaldado por el CRTM, la EMT, Metro de Madrid, Renfe Cercanías, la Comunidad de Madrid ni el Ayuntamiento de Madrid.** «CRTM», «Madrid» y los nombres de líneas, operadores y municipios pertenecen a sus titulares y se usan aquí de forma meramente descriptiva. La app usa iconos propios: no incluye logos oficiales.

La información se ofrece **tal cual (AS IS)**, con fines puramente informativos y sin garantía de exactitud, disponibilidad ni continuidad. Si la app falla, normalmente es porque la fuente original ha cambiado o no responde.

## Datos y reutilización (RISP)

Los datos provienen de la información pública del CRTM y se reutilizan al amparo de la **Ley 37/2007, de 16 de noviembre, sobre reutilización de la información del sector público (RISP)**, y de la **Directiva (UE) 2019/1024, de 20 de junio, sobre datos abiertos y reutilización de la información del sector público**. Se transforman únicamente para su presentación y no implican relación alguna con el organismo de origen ni con los operadores.

## Privacidad

Sin login, sin cookies de seguimiento, sin analítica de terceros y sin venta de datos. Los favoritos viven en tu navegador; la geolocalización solo se usa si pulsas «cerca de mí» y no se almacena. Detalles en [Privacidad y aviso legal](https://ercharles.github.io/b4us/privacy.html).

## Licencia

Distribuido bajo licencia **MIT**. Puedes usar, copiar, modificar y redistribuir el código citando la licencia y el aviso de copyright. El software se entrega **sin garantías**, «tal cual». Texto completo en [LICENSE](LICENSE).

## Contacto

Dudas, fallos o peticiones sobre marcas y datos: abre un *issue* en https://github.com/ErCharles/b4us/issues.

## Desarrollo

```bash
npm install
npm start   # backend Fastify (src/)
npm test    # node --test test/*.test.js
```

El frontend está en `public/` (se publica en GitHub Pages) y el backend en `src/`.

Mapa (escritorio): teselas CARTO raster con `?key=` — ver [DEPLOY.md §5](DEPLOY.md).
