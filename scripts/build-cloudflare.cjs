const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'artifacts', 'cloudflare-assets');
// Only this generated assets directory is cleared; database/exports never enter it.
if (path.dirname(target) !== path.join(root, 'artifacts')) throw new Error('Invalid build directory.');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const item of fs.readdirSync(path.join(root, 'public'))) {
  fs.cpSync(path.join(root, 'public', item), path.join(target, item), { recursive: true });
}
fs.cpSync(path.join(root, 'shared'), path.join(target, 'shared'), { recursive: true });
console.log('Assets da loja preparados em artifacts/cloudflare-assets (public + shared).');
