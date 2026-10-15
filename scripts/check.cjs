const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename) : /\.(?:js|cjs|mjs)$/.test(entry.name) ? [filename] : [];
  });
}
const files = ['server.js', ...['src', 'shared', 'public/js', 'scripts', 'test', 'cloudflare'].flatMap(directory => sourceFiles(path.join(root, directory)))];
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    failed = true;
    console.error(path.relative(root, path.resolve(root, file)) + ': ' + (result.stderr || result.error?.message));
  }
}
if (failed) process.exitCode = 1;
else console.log(`Sintaxe verificada em ${files.length} arquivos JavaScript.`);
