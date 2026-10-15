const crypto = require('node:crypto');

const SESSION_DURATION = 12 * 3600000;
const LOGIN_WINDOW = 5 * 60000;
const MAX_FAILURES = 5;
const hash = value => crypto.createHash('sha256').update(value).digest();

function createAuth(password, { tokens = new Map(), attempts = new Map() } = {}) {
  const passwordHash = hash(password);
  function prune() {
    const now = Date.now();
    for (const [token, expires] of tokens) if (expires <= now) tokens.delete(token);
    for (const [ip, attempt] of attempts) if (attempt.expires <= now) attempts.delete(ip);
  }

  function login(req, res) {
    prune();
    if (typeof req.body?.password !== 'string') return res.status(400).json({ error: 'Informe uma senha válida.' });
    const ip = req.ip;
    const attempt = attempts.get(ip);
    if (attempt?.failures >= MAX_FAILURES) {
      res.set('Retry-After', String(Math.ceil((attempt.expires - Date.now()) / 1000)));
      return res.status(429).json({ error: 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.' });
    }
    if (!crypto.timingSafeEqual(hash(req.body.password), passwordHash)) {
      attempts.set(ip, { failures: (attempt?.failures || 0) + 1, expires: attempt?.expires || Date.now() + LOGIN_WINDOW });
      return res.status(401).json({ error: 'Senha incorreta.' });
    }
    attempts.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(token, Date.now() + SESSION_DURATION);
    res.json({ token });
  }

  function authenticate(req, res, next) {
    const token = req.get('x-token');
    const expires = tokens.get(token);
    if (!expires || expires <= Date.now()) {
      tokens.delete(token);
      return res.status(401).json({ error: 'Sessão expirada.' });
    }
    next();
  }

  function logout(req, res) {
    tokens.delete(req.get('x-token'));
    res.json({ ok: true });
  }
  return { login, authenticate, logout };
}

module.exports = { createAuth };
