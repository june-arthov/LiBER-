// src/daemon/core/http-guard.js — two decisions every request makes before routing.
//
// Kept pure and small so both can be tested without a socket: which browser origin
// is allowed to read a response, and how many requests an unauthenticated address
// may make. Neither is a substitute for the bearer token; they shrink what a page
// the user happens to visit, or a local probe, can do before it gets that far.

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** Returns the origin to reflect, or null when it must not be echoed back. */
function allowOrigin(origin) {
  const value = String(origin || '');
  return LOOPBACK.test(value) ? value : null;
}

/**
 * A per-address ceiling for routes that answer without a token.
 * 240/min is far above what a shell does and far below what a probe wants.
 */
function createThrottle({ limit, windowMs = 60000 } = {}) {
  const max = Number.isFinite(limit) ? limit : (Number(process.env.LIBER_UNAUTH_RPM) || 240);
  const buckets = new Map();

  return {
    limit: max,
    windowMs,
    check(ip, now = Date.now()) {
      const key = String(ip || 'local');
      let bucket = buckets.get(key);
      if (!bucket || now >= bucket.reset) {
        bucket = { count: 0, reset: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      const allowed = bucket.count <= max;
      return {
        allowed,
        remaining: Math.max(0, max - bucket.count),
        retryAfterMs: allowed ? 0 : Math.max(0, bucket.reset - now)
      };
    },
    reset() { buckets.clear(); },
    get size() { return buckets.size; }
  };
}

module.exports = { allowOrigin, createThrottle, LOOPBACK };
