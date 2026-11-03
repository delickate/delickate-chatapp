'use strict';

const fs = require('node:fs');
const path = require('node:path');

const packagePath = path.join(__dirname, '..', 'node_modules', '@electron', 'packager', 'package.json');
const sourcePath = path.join(__dirname, '..', 'node_modules', '@electron', 'packager', 'dist', 'platform.js');

if (!fs.existsSync(packagePath) || !fs.existsSync(sourcePath)) {
  throw new Error('Electron Packager is not installed. Run npm install before building.');
}

const packager = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
if (packager.version !== '20.3.0') {
  throw new Error(`The Windows Packager compatibility patch expects @electron/packager 20.3.0; found ${packager.version}.`);
}

const source = fs.readFileSync(sourcePath, 'utf8');
const original = "if (err.code === 'EXDEV') {";
const patched = "if (err.code === 'EXDEV' ||\n                (process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(err.code))) {";

if (!source.includes(patched)) {
  if (!source.includes(original)) {
    throw new Error('Could not apply the Windows Packager compatibility patch; inspect platform.js before building.');
  }

  const updated = source
    .replace(original, patched)
    .replace('// Cross-device link, fallback to copy and delete.', '// Copy and delete for cross-device moves and transient Windows file locks.');
  fs.writeFileSync(sourcePath, updated);
}
