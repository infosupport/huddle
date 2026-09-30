// tsc only compiles .ts files, so src/devcontainer-scripts/*.sh never reaches
// dist/ on its own. Copy it next to dist/index.js after every build so a
// plain checkout run (`node dist/index.js`) can read it via __dirname — see
// gateway/src/devcontainer-scripts.ts, and build-sea.mjs for the packaged-
// binary equivalent (embedded as a blob asset instead of a dist/ file).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.resolve(HERE, '..');
const SRC = path.join(GATEWAY, 'src', 'devcontainer-scripts');
const DEST = path.join(GATEWAY, 'dist', 'devcontainer-scripts');

fs.mkdirSync(DEST, { recursive: true });
for (const name of fs.readdirSync(SRC)) {
  fs.copyFileSync(path.join(SRC, name), path.join(DEST, name));
}
