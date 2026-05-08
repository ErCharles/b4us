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
  },
  sse: {
    heartbeatInterval: 15000,
    updateInterval: 5000,
  },
  rateLimit: {
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    timeWindow: '1 minute',
  },
  // CRTM transport mode codes
  modes: {
    METRO: 4,
    CERCANIAS: 5,
    EMT: 6,
    INTERURBANO: 8,
    METRO_LIGERO: 10,
  },
};

module.exports = config;
