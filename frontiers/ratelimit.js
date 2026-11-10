// A small in-memory rate limiter. Good for one dyno, which is all this needs.
// Addresses are only ever held here, for as long as their window lasts: they
// are never written anywhere.
//
//   const limiter = createLimiter();
//   limiter.limit({ name, max, windowMs, error })   express middleware, by client IP
//   limiter.hit(name, key, max, windowMs)    the same count, by hand
//
// Trust proxy is on, so req.ip is the real address behind Heroku's router.

function createLimiter() {
  const buckets = new Map(); // `${name}:${key}` -> { count, resetAt }

  function hit(name, key, max, windowMs) {
    const id = `${name}:${key}`;
    const now = Date.now();
    let b = buckets.get(id);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(id, b); }
    b.count += 1;
    return { allowed: b.count <= max, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }

  function limit({ name, max, windowMs, error = 'Too many reports. Try again later.' }) {
    return (req, res, next) => {
      const r = hit(name, req.ip || 'unknown', max, windowMs);
      if (r.allowed) return next();
      res.setHeader('Retry-After', String(r.retryAfter));
      res.status(429).json({ error });
    };
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, b] of buckets) if (b.resetAt <= now) buckets.delete(id);
  }, 60_000);
  if (sweeper.unref) sweeper.unref();

  return { limit, hit };
}

module.exports = { createLimiter };
