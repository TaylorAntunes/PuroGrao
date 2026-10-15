const { isIP } = require('node:net');

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' https://fonts.googleapis.com",
  // Existing product positions, colours and stock charts use style attributes.
  "style-src-attr 'unsafe-inline'",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "form-action 'self'",
  "worker-src 'none'",
].join('; ');
const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()';

function readTrustProxy(value) {
  const text = String(value || '').trim();
  if (!text || ['false', '0'].includes(text.toLowerCase())) return false;
  const addresses = text.split(',').map(address => address.trim());
  const valid = addresses.every(address => {
    if (address.toLowerCase() === 'loopback') return true;
    const match = address.match(/^([a-f\d:.]+)(?:\/(\d{1,3}))?$/i);
    if (!match) return false;
    const version = isIP(match[1]);
    if (!version) return false;
    return match[2] === undefined || Number(match[2]) > 0 && Number(match[2]) <= (version === 4 ? 32 : 128);
  });
  if (!valid) throw new Error('TRUST_PROXY deve conter somente IPs, sub-redes específicas ou loopback. Não use true, número de saltos ou uma rede /0.');
  return addresses.map(address => address.toLowerCase() === 'loopback' ? 'loopback' : address);
}

function readSecurityConfig(env = process.env) {
  const production = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const host = String(env.HOST || '127.0.0.1').trim();
  if (host !== 'localhost' && !isIP(host)) throw new Error('HOST deve ser localhost ou um endereço IP válido.');
  const trustProxy = readTrustProxy(env.TRUST_PROXY);
  const publicUrl = String(env.PUBLIC_URL || '').trim();
  let canonical = null;
  if (publicUrl) {
    try { canonical = new URL(publicUrl); } catch (_) {}
    if (!canonical || canonical.protocol !== 'https:' || canonical.username || canonical.password ||
        canonical.pathname !== '/' || canonical.search || canonical.hash) {
      throw new Error('PUBLIC_URL deve ser uma origem HTTPS, sem usuário, senha, caminho, consulta ou fragmento.');
    }
  }
  return { production, host, trustProxy, publicOrigin: canonical?.origin || null, publicHostname: canonical?.hostname || null };
}

function requestHostname(req) {
  const host = req.get('host');
  if (!host || /[\s\\/@,?#]/.test(host)) return null;
  try { return new URL(`https://${host}`).hostname; } catch (_) { return null; }
}

function configureSecurity(app, config = readSecurityConfig()) {
  app.set('trust proxy', config.trustProxy);
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': PERMISSIONS_POLICY,
    });
    // Local HTTP remains usable. HSTS is emitted only for secure production requests.
    if (config.production && req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    if (!config.production) return next();

    const hostname = requestHostname(req);
    if (!hostname) return res.status(400).set('Cache-Control', 'no-store').json({ error: 'Endereço do site inválido.' });
    if (config.publicHostname && hostname !== config.publicHostname) {
      return res.status(421).set('Cache-Control', 'no-store').json({ error: 'Use o endereço oficial do site.' });
    }
    if (req.secure) return next();

    res.set('Cache-Control', 'no-store');
    if (config.publicOrigin && ['GET', 'HEAD'].includes(req.method)) {
      const target = req.originalUrl;
      if (!target.startsWith('/') || target.startsWith('//') || /[\\\r\n]/.test(target)) {
        return res.status(400).json({ error: 'Endereço do site inválido.' });
      }
      // Never use Host or X-Forwarded-Host to build a redirect destination.
      return res.redirect(308, config.publicOrigin + target);
    }
    // Do not replay login credentials or orders received through plain HTTP.
    return res.status(426).set('Upgrade', 'TLS/1.2').json({ error: 'Use uma conexão HTTPS para acessar o site.' });
  });
}

module.exports = { configureSecurity, readSecurityConfig, CONTENT_SECURITY_POLICY, PERMISSIONS_POLICY };
