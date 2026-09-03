#!/usr/bin/env node
/** Keep CLI and optional platform-package versions in lockstep for a release. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('usage: node scripts/set-cli-release-version.mjs <semver>');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(root, 'cli', 'package.json');
const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
pkg.version = version;
for (const name of Object.keys(pkg.optionalDependencies ?? {})) pkg.optionalDependencies[name] = version;
fs.writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
