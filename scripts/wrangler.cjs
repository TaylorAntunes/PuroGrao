const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Express' Node dependencies must use their Node entry points. The browser build
// of iconv-lite intentionally removes streams needed by body-parser in Workers.
const cli = path.join(path.dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit', windowsHide: true,
  env: { ...process.env, WRANGLER_BUILD_PLATFORM: 'node' },
});
if (result.error) { console.error(result.error.message); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
