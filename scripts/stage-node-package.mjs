#!/usr/bin/env node
/** Stage one native SEA build into the npm package selected by os/cpu. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const platform = value('--platform') ?? process.platform;
const arch = value('--arch') ?? process.arch;
const version = value('--version');
const target = `${platform}-${arch}`;
// `file` is what build-sea.mjs (gateway/scripts/build-sea.mjs) actually
// produces under gateway/build/sea/ — a bare executable everywhere except
// macOS, where it's the Huddle.app bundle wrapping huddle-node (step 9; the
// bundle is what gives Finder/Activity Monitor/Dock an icon there, since a
// bare Unix executable has nowhere to carry one).
const packages = new Map([
  ['win32-x64', { dir: 'huddle-node-win32-x64', file: 'huddle-node.exe' }],
  ['darwin-x64', { dir: 'huddle-node-darwin-x64', file: 'Huddle.app' }],
  ['darwin-arm64', { dir: 'huddle-node-darwin-arm64', file: 'Huddle.app' }],
  ['linux-x64', { dir: 'huddle-node-linux-x64', file: 'huddle-node' }],
]);
const spec = packages.get(target);
if (!spec) throw new Error(`unsupported Huddle Node package target: ${target}`);
if (platform !== process.platform || arch !== process.arch) {
  throw new Error(`SEA builds must be native: requested ${target}, running ${process.platform}-${process.arch}`);
}

const source = path.join(ROOT, 'gateway', 'build', 'sea', spec.file);
if (!fs.existsSync(source)) throw new Error(`SEA executable missing: ${source}`);
const out = path.join(ROOT, 'packages', spec.dir);
const bin = path.join(out, 'bin');
fs.mkdirSync(bin, { recursive: true });
const dest = path.join(bin, spec.file);
// The macOS artefact is a directory (the .app bundle); everywhere else it's
// a single file. cp -r handles both, but stays a plain file copy elsewhere so
// this doesn't start silently accepting a directory where a single
// executable was expected on win32/linux.
if (platform === 'darwin') {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(source, dest, { recursive: true });
  fs.chmodSync(path.join(dest, 'Contents', 'MacOS', 'huddle-node'), 0o755);
} else {
  fs.copyFileSync(source, dest);
  if (platform !== 'win32') fs.chmodSync(dest, 0o755);
}

if (version) {
  const manifest = path.join(out, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
}
console.log(`staged ${target}: ${path.join(bin, spec.file)}`);
