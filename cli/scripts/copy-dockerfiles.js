// Copies the devcontainer base-image Dockerfiles from the repo root into the
// package (cli/images/<name>/Dockerfile), so the published CLI can build the
// images on the user's machine. Runs before `tsc` in `npm run build`.
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const outDir = path.resolve(__dirname, '..', 'images');
const names = ['base-devimage', 'base-devimage-vscode', 'base-devimage-intellij', 'base-devimage-rider', 'base-devimage-webstorm'];

fs.rmSync(outDir, { recursive: true, force: true });
for (const name of names) {
  const src = path.join(repoRoot, name, 'Dockerfile');
  if (!fs.existsSync(src)) throw new Error(`Missing ${src}`);
  fs.mkdirSync(path.join(outDir, name), { recursive: true });
  fs.copyFileSync(src, path.join(outDir, name, 'Dockerfile'));
}
console.log(`Copied ${names.length} Dockerfiles to ${path.relative(process.cwd(), outDir) || outDir}`);
