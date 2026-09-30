#!/usr/bin/env node
/**
 * Parallel counterpart to install-subprojects.mjs (the root `install`
 * lifecycle script) — runs `npm install` in gateway/, gateway/frontend/ and
 * cli/ concurrently instead of one after another. Useful as a quick "reinstall
 * everywhere" after switching platforms on a shared checkout (e.g. the Linux
 * devcontainer vs. native Windows re-triggers the esbuild native-binary
 * mismatch each way — see scripts/dev-full.mjs's header comment for that
 * story), where the three installs are independent and waiting for them one
 * at a time is just wasted wall-clock.
 *
 * Deliberately NOT wired into the root `install` lifecycle script itself —
 * that one stays sequential and is exercised as-is in CI. It follows the
 * same two fixes install-subprojects.mjs documents for a Windows-only
 * recursion bug (cwd, not --prefix; npm_execpath, not "npm") for the same
 * reasons; nothing about running concurrently changes either of those.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUBPROJECTS = ['gateway', 'gateway/frontend', 'cli'];

// Set by npm for anything it runs. Absent only if someone runs this by hand.
const npmCli = process.env.npm_execpath;

function prefixLines(label, text) {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => `[${label}] ${line}`)
    .join('\n');
}

function installOne(dir) {
  const cwd = path.join(ROOT, dir);
  console.log(`> installing ${dir}/`);

  return new Promise((resolve) => {
    const child = npmCli
      ? spawn(process.execPath, [npmCli, 'install'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('npm', ['install'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true });

    // All three run at once, so their output is interleaved by definition —
    // prefixing each line with its subproject is what keeps that readable
    // instead of three unattributed streams mixed together.
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (buf) => {
        const text = prefixLines(dir, buf.toString('utf8').replace(/\n$/, ''));
        if (text) console.log(text);
      });
    }

    child.on('error', (err) => {
      console.error(`[${dir}] failed to start npm: ${err.message}`);
      resolve({ dir, status: 1 });
    });
    child.on('close', (status) => resolve({ dir, status: status ?? 1 }));
  });
}

async function main() {
  const results = await Promise.all(SUBPROJECTS.map(installOne));
  const failed = results.filter((r) => r.status !== 0);
  if (failed.length > 0) {
    console.error(`\nnpm install failed in: ${failed.map((f) => f.dir).join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll subprojects installed.');
}

main();
