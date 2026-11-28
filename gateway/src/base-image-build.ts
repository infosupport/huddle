// Devcontainer base images are built locally instead of pulled from a registry
// (`huddle init` starts that build in the background, see cli/src/base-images.ts).
// When a devcontainer starts and its image is still missing, the gateway first
// waits for a running CLI build and otherwise builds the image itself from the
// Dockerfiles the CLI staged in ~/.huddle/images (mounted at /huddle-home).
import fs from 'fs';
import path from 'path';

const HOME_DIR = process.env.HUDDLE_HOME_DIR || '/huddle-home';
const STATUS_PATH = path.join(HOME_DIR, 'images', 'build-status.json');

/** A CLI build whose status was not updated for this long is considered dead. */
const STALE_MS = 60 * 60 * 1000;
const WAIT_MAX_MS = 30 * 60 * 1000;
const POLL_MS = 5000;

export const DEFAULT_BASE_IMAGE = 'localhost/huddle/base-devimage:latest';

export function baseImageName(): string {
  return process.env.BASE_IMAGE ?? DEFAULT_BASE_IMAGE;
}

export interface BuildDeps {
  imageExists(name: string): Promise<boolean>;
  buildImage(name: string, dockerfilePath: string, buildArgs?: Record<string, string>): Promise<void>;
  /** Overridable in tests. */
  readStatus?(): { state?: string; updatedAt?: string } | undefined;
  fileExists?(p: string): boolean;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  log?(msg: string): void;
}

function readCliStatus(): { state?: string; updatedAt?: string } | undefined {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Dockerfile for `base-devimage` or `base-devimage-<ide>`: staged by the CLI, or the legacy root mount. */
export function dockerfileFor(folder: string, fileExists: (p: string) => boolean = fs.existsSync): string | undefined {
  return [path.join(HOME_DIR, 'images', folder, 'Dockerfile'), `/${folder}/Dockerfile`].find(fileExists);
}

/**
 * Makes sure `imageName` (the base image of `ide`) exists, building the shared
 * base first when needed. Throws with a clear message when no Dockerfile is
 * available, e.g. because the CLI never ran `huddle init`.
 */
export async function ensureBaseImage(ide: string, imageName: string, deps: BuildDeps): Promise<void> {
  const exists = deps.imageExists;
  const fileExists = deps.fileExists ?? fs.existsSync;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(`[huddle] ${m}`));
  const status = deps.readStatus ?? readCliStatus;

  if (await exists(imageName)) return;

  // A build started by `huddle init` is probably producing this image right now.
  const deadline = now() + WAIT_MAX_MS;
  let waited = false;
  for (;;) {
    const s = status();
    const fresh = s?.state === 'building' && s.updatedAt !== undefined && now() - Date.parse(s.updatedAt) < STALE_MS;
    if (!fresh || now() >= deadline) break;
    if (!waited) log(`Waiting for the running base-image build before starting '${imageName}'...`);
    waited = true;
    await sleep(POLL_MS);
    if (await exists(imageName)) return;
  }

  const base = baseImageName();
  if (!(await exists(base))) {
    const baseFile = dockerfileFor('base-devimage', fileExists);
    if (!baseFile) throw new Error(`Image '${base}' not found and no Dockerfile available; run "huddle images build"`);
    log(`Building base image '${base}' from ${baseFile}...`);
    await deps.buildImage(base, baseFile);
  }
  const ideFile = dockerfileFor(`base-devimage-${ide}`, fileExists);
  if (!ideFile) throw new Error(`Image '${imageName}' not found and no Dockerfile available; run "huddle images build"`);
  log(`Building base image '${imageName}' from ${ideFile}...`);
  await deps.buildImage(imageName, ideFile, { BASE_IMAGE: base });
  log(`Base image '${imageName}' built successfully`);
}
