#!/usr/bin/env node
/**
 * Installs the dependencies of gateway/ and cli/. Runs as the root package's
 * `install` lifecycle script, so a plain `npm install` at the repo root sets up
 * the whole monorepo — which README.md, CONTRIBUTING.md and .github/workflows/
 * test.yml all tell you to do.
 *
 * This used to be a one-liner in package.json:
 *
 *     "install": "npm --prefix gateway install && npm --prefix cli install"
 *
 * `--prefix` is meant to scope the install to that directory. On Windows it does
 * not: npm installs the package in the CURRENT directory instead, which during a
 * lifecycle script is the repo root — so the root's `install` script ran itself
 * again, and again, ~30 levels deep, until the nested shell lost npm off its
 * PATH and the whole thing collapsed with a half-written node_modules behind it.
 * Linux was unaffected, which is why it survived so long.
 *
 * Two things here make that impossible rather than unlikely:
 *
 *   - cwd, not --prefix. npm locates the project by walking UP from the working
 *     directory; started in gateway/ it finds gateway/package.json and stops. It
 *     cannot reach the root's package.json, so the lifecycle script cannot
 *     re-enter regardless of what --prefix does on any given platform.
 *   - npm_execpath, not "npm". npm exports the path to its own CLI; running it
 *     under process.execPath needs no PATH lookup and no shell, which is the
 *     other half of what failed above ('npm' is not recognized).
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUBPROJECTS = ['gateway', 'cli'];

// Set by npm for anything it runs. Absent only if someone runs this by hand.
const npmCli = process.env.npm_execpath;

for (const dir of SUBPROJECTS) {
  const cwd = path.join(ROOT, dir);
  console.log(`\n> installing ${dir}/`);

  const { status, error } = npmCli
    ? spawnSync(process.execPath, [npmCli, 'install'], { cwd, stdio: 'inherit' })
    : spawnSync('npm', ['install'], { cwd, stdio: 'inherit', shell: true });

  if (error) {
    console.error(`\nfailed to start npm for ${dir}/: ${error.message}`);
    process.exit(1);
  }
  if (status !== 0) {
    console.error(`\nnpm install failed in ${dir}/ (exit ${status})`);
    process.exit(status ?? 1);
  }
}
