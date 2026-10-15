const positiveInteger = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

function createOrderLimits(options = {}) {
  const windowMs = positiveInteger(options.windowMs ?? process.env.ORDER_RATE_WINDOW_MS, 15 * 60000);
  const maxNew = positiveInteger(options.maxNew ?? process.env.ORDER_RATE_MAX_NEW, 10);
  const maxAttempts = positiveInteger(options.maxAttempts ?? process.env.ORDER_RATE_MAX_ATTEMPTS, 30);
  const maxIps = positiveInteger(options.maxIps ?? process.env.ORDER_RATE_MAX_IPS, 5000);
  const clock = options.clock || (() => Date.now());
  const entries = options.entries || new Map();
  let nextPrune = 0;
  const seconds = expires => Math.max(1, Math.ceil((expires - clock()) / 1000));
  const limited = expires => Object.assign(new Error('Muitos pedidos enviados. Aguarde alguns minutos antes de tentar novamente.'),
    { status: 429, retry_after_seconds: seconds(expires) });

  function entryFor(ip) {
    const now = clock();
    if (now >= nextPrune || entries.size >= maxIps) {
      for (const [key, value] of entries) if (value.expires <= now) entries.delete(key);
      nextPrune = now + Math.min(windowMs, 60000);
    }
    const key = String(ip || 'unknown');
    let entry = entries.get(key);
    if (entry?.expires <= now) { entries.delete(key); entry = null; }
    if (!entry) {
      // Bound memory without evicting active limits: new IPs wait when capacity is full.
      if (entries.size >= maxIps) {
        let expires = Infinity;
        for (const value of entries.values()) expires = Math.min(expires, value.expires);
        throw limited(expires);
      }
      entry = { attempts: 0, created: 0, expires: now + windowMs };
      entries.set(key, entry);
    }
    return entry;
  }

  function attempt(req, res, next) {
    res.set('Cache-Control', 'no-store');
    try {
      const entry = entryFor(req.ip);
      if (entry.attempts >= maxAttempts) throw limited(entry.expires);
      entry.attempts++;
      entries.set(String(req.ip || 'unknown'), entry);
      next();
    } catch (error) {
      res.set('Retry-After', String(error.retry_after_seconds));
      res.status(429).json({ error: error.message });
    }
  }
  function assertCreation(ip) {
    const entry = entryFor(ip);
    if (entry.created >= maxNew) throw limited(entry.expires);
  }
  function recordCreation(ip) {
    const entry = entryFor(ip);
    entry.created++;
    entries.set(String(ip || 'unknown'), entry);
  }
  return { attempt, assertCreation, recordCreation, trackedIps: () => entries.size };
}

module.exports = { createOrderLimits };
