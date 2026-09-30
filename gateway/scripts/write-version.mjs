#!/usr/bin/env node
/**
 * Stamps src/version.ts with the version shown in the UI sidebar. CI sets
 * HUDDLE_VERSION (the same GitVersion-computed semver used to publish the
 * huddle-node-* packages, see .github/workflows/publish-npm.yml) before
 * running the build, so the UI matches the version on the package a user
 * actually installed. Locally, with no such env var, falls back to `git
 * describe` for a still-useful dev build stamp; version.ts's own checked-in
 * 'dev' default covers the rare case where even that fails (no .git, e.g. a
 * source tarball).
 *
 * Runs as its own step ahead of `tsc` in both gateway/package.json's
 * `build:ts` and build-sea.mjs — whichever compiles second wouldn't see a
 * fresh value otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveVersion() {
  if (process.env.HUDDLE_VERSION) return process.env.HUDDLE_VERSION;
  try {
    return execSync('git describe --tags --always --dirty', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

const version = resolveVersion();
const file = path.join(ROOT, 'src', 'version.ts');
fs.writeFileSync(
  file,
  `// Generated at build time by scripts/write-version.mjs — do not hand-edit.\nexport const HUDDLE_VERSION: string = ${JSON.stringify(version)};\n`,
);
console.log(`[write-version] HUDDLE_VERSION = ${version}`);
