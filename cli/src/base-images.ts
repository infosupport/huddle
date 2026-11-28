import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from './config';
import { bold, dim, green, yellow } from './utils';

/**
 * Devcontainer base images are built on the user's machine instead of pulled
 * from a registry. That way nobody has to publish a new image for every Claude
 * Code (or Codex/Copilot) release: `huddle images build --refresh` picks up the
 * latest versions.
 *
 * Names live under `localhost/` so a missing image can never be resolved to a
 * public registry (e.g. a Docker Hub namespace called "huddle"); Podman also
 * uses `localhost/` for local images.
 */

export const IDES = ['vscode', 'intellij', 'rider', 'webstorm'] as const;
export type Ide = (typeof IDES)[number];

export const BASE_NAME = 'base-devimage';

/** Local image for the shared base or one IDE, for a channel tag (`latest` or `experiment-<nr>`). */
export function localImageName(ide: Ide | undefined, tag: string): string {
  return `localhost/huddle/${ide ? `${BASE_NAME}-${ide}` : BASE_NAME}:${tag}`;
}

/** Where `huddle init` stages the Dockerfiles; mounted into the gateway as /huddle-home/images. */
export const STAGED_DIR = path.join(CONFIG_DIR, 'images');
const LOG_PATH = path.join(STAGED_DIR, 'build.log');
const STATUS_PATH = path.join(STAGED_DIR, 'build-status.json');

export interface BuildStep {
  /** Folder name, e.g. `base-devimage-vscode`. */
  name: string;
  ide?: Ide;
  image: string;
  buildArgs: Record<string, string>;
}

/**
 * The images to build, base first (the IDE images build on top of it). Pure, so
 * it is unit-tested. With `refresh` every image is rebuilt; otherwise images that
 * already exist are skipped, except that a rebuilt base forces its IDE images.
 */
export function buildPlan(tag: string, ides: readonly Ide[], exists: (image: string) => boolean, refresh: boolean): BuildStep[] {
  const base = localImageName(undefined, tag);
  const steps: BuildStep[] = [];
  const baseNeeded = refresh || !exists(base);
  if (baseNeeded) steps.push({ name: BASE_NAME, image: base, buildArgs: {} });
  for (const ide of ides) {
    const image = localImageName(ide, tag);
    if (baseNeeded || !exists(image)) {
      steps.push({ name: `${BASE_NAME}-${ide}`, ide, image, buildArgs: { BASE_IMAGE: base } });
    }
  }
  return steps;
}

/** The Dockerfiles shipped with the CLI package (copied there by scripts/copy-dockerfiles.js). */
function packagedDir(): string {
  return path.resolve(__dirname, '..', 'images');
}

/**
 * Copies the packaged Dockerfiles to ~/.huddle/images, so the gateway (which
 * mounts ~/.huddle) can build a missing image itself on the first start.
 */
export function stageDockerfiles(): void {
  const src = packagedDir();
  if (!fs.existsSync(src)) throw new Error(`Dockerfiles not found in ${src}; is the CLI package complete?`);
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name, 'Dockerfile');
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.join(STAGED_DIR, name), { recursive: true });
    fs.copyFileSync(from, path.join(STAGED_DIR, name, 'Dockerfile'));
  }
}

function imageExists(rt: string, image: string): boolean {
  return spawnSync(rt, ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;
}

interface BuildStatus {
  state: 'building' | 'done' | 'failed';
  tag: string;
  image?: string;
  error?: string;
  updatedAt: string;
}

function writeStatus(status: Omit<BuildStatus, 'updatedAt'>): void {
  fs.mkdirSync(STAGED_DIR, { recursive: true });
  fs.writeFileSync(STATUS_PATH, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2));
}

export function readStatus(): BuildStatus | undefined {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')) as BuildStatus;
  } catch {
    return undefined;
  }
}

export interface BuildOptions {
  rt: string;
  tag: string;
  ides?: readonly Ide[];
  refresh?: boolean;
}

/**
 * Builds the images in the foreground (output to stdout/stderr). Returns false
 * when a build failed; the rest of the plan is then skipped, because the IDE
 * images cannot build without their base.
 */
export function buildImages(opts: BuildOptions): boolean {
  stageDockerfiles();
  const ides = opts.ides ?? IDES;
  const plan = buildPlan(opts.tag, ides, (img) => imageExists(opts.rt, img), !!opts.refresh);
  if (plan.length === 0) {
    console.log(green('[OK] All devcontainer base images are present.') + dim(' Use --refresh to rebuild with the latest tools.'));
    writeStatus({ state: 'done', tag: opts.tag });
    return true;
  }
  for (const step of plan) {
    console.log(bold(`Building ${step.image}`));
    writeStatus({ state: 'building', tag: opts.tag, image: step.image });
    const dir = path.join(STAGED_DIR, step.name);
    const args = ['build', '-t', step.image];
    for (const [k, v] of Object.entries(step.buildArgs)) args.push('--build-arg', `${k}=${v}`);
    // --pull refreshes the upstream images (Debian, devcontainers) but never our own
    // localhost/ base, which only exists locally.
    if (opts.refresh) args.push('--no-cache', ...(step.ide ? [] : ['--pull']));
    args.push('-f', path.join(dir, 'Dockerfile'), dir);
    const res = spawnSync(opts.rt, args, { stdio: 'inherit' });
    if (res.status !== 0) {
      const error = `build of ${step.image} failed (exit ${res.status ?? res.signal})`;
      console.log(yellow(`[!] ${error}`));
      writeStatus({ state: 'failed', tag: opts.tag, image: step.image, error });
      return false;
    }
  }
  console.log(green(`[OK] Built ${plan.length} image(s).`));
  writeStatus({ state: 'done', tag: opts.tag });
  return true;
}

/**
 * Starts the build in a detached process so `huddle init` does not wait for it.
 * The gateway waits for a running build before it builds a missing image itself.
 */
export function startBackgroundBuild(rt: string, tag: string): void {
  stageDockerfiles();
  writeStatus({ state: 'building', tag });
  const out = fs.openSync(LOG_PATH, 'w');
  const child = spawn(process.execPath, [process.argv[1], 'images', 'build', '--runtime', rt], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, HUDDLE_IMAGES_TAG: tag },
  });
  child.unref();
  fs.closeSync(out);
  console.log(dim(`Building devcontainer base images in the background (log: ${LOG_PATH})`));
  console.log(dim('  The first start of a devcontainer waits for it; check progress with "huddle images status".'));
}

export function printStatus(rt: string, tag: string): void {
  const status = readStatus();
  console.log(`Channel tag: ${tag}`);
  if (status) {
    const detail = status.state === 'building' && status.image ? ` (${status.image})` : status.error ? ` (${status.error})` : '';
    console.log(`Last build:  ${status.state}${detail}, ${status.updatedAt}`);
  }
  for (const ide of [undefined, ...IDES]) {
    const image = localImageName(ide, tag);
    console.log(`  ${imageExists(rt, image) ? green('present') : yellow('missing')}  ${image}`);
  }
  if (fs.existsSync(LOG_PATH)) console.log(dim(`Log: ${LOG_PATH}`));
}
