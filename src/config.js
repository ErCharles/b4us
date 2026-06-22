'use strict';

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: '0.0.0.0',
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  crtm: {
    baseUrl: process.env.CRTM_BASE_URL || 'https://www.crtm.es/widgets/api',
    timeout: parseInt(process.env.CRTM_TIMEOUT || '8000', 10),
    retries: parseInt(process.env.CRTM_RETRIES || '2', 10),
    userAgent: 'Madrid Transport/3.8.2 (Android 14; SDK 34)',
  },
  cache: {
    freshTtl: parseInt(process.env.CACHE_FRESH_TTL || '5', 10),
    staleTtl: parseInt(process.env.CACHE_STALE_TTL || '60', 10),
    lockTtl: parseInt(process.env.CACHE_LOCK_TTL || '3', 10),
    // Negative caching: when upstream errors, suppress retries for this many seconds.
    // Keep short — the goal is "don't hammer", not "stay broken".
    negativeTtl: parseInt(process.env.CACHE_NEGATIVE_TTL || '30', 10),
    // Live (ETA) endpoints poll every `updateInterval`. Keep fresh just under
    // that so each poll fetches near-live data, and keep the negative window
    // short so a 1s CRTM blip doesn't freeze a stop for 30s.
    liveFreshTtl: parseInt(process.env.CACHE_LIVE_FRESH_TTL || '4', 10),
    liveNegativeTtl: parseInt(process.env.CACHE_LIVE_NEGATIVE_TTL || '8', 10),
  },
  sse: {
    heartbeatInterval: 15000,
    updateInterval: 5000,
  },
  rateLimit: {
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    timeWindow: '1 minute',
  },
  cors: {
    // Comma-separated allowlist. Includes the GitHub Pages origin because the
    // frontend can be served from there and call this API cross-origin.
    // Set ALLOWED_ORIGINS to override; '*' disables the allowlist (dev only).
    allowedOrigins: (process.env.ALLOWED_ORIGINS ||
      'https://bus.carloscyberseces.com,https://ercharles.github.io')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },
};

// Shared origin check for the CORS plugin (server.js) and the hijacked SSE
// raw response (routes/sse.js), so both enforce the same allowlist.
config.isAllowedOrigin = function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin requests / curl send no Origin
  const list = config.cors.allowedOrigins;
  if (list.includes('*') || list.includes(origin)) return true;
  if (process.env.NODE_ENV !== 'production' &&
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
};

module.exports = config;
