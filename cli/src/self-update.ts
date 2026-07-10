import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { bold, dim } from './utils';

/**
 * Infrastructure for CLI self-updates: version info of the running build,
 * global (re)installation via npm, and restarting the process itself.
 * Which version should be installed (stable or experiment) is a domain
 * decision and lives in experiment.ts.
 */

export const CLI_PACKAGE = '@infosupport/huddle-cli';

// Guard against a restart loop: set on a relaunch, so the new CLI doesn't
// reinstall again if the version still doesn't match.
const RELAUNCH_ENV = 'HUDDLE_EXPERIMENT_RELAUNCHED';

export function cliVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return String(pkg.version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

/**
 * Switches the global CLI to the given package spec and then restarts this
 * process with relaunchArgs. Never returns: the process exits with the exit
 * code of the new CLI, or this function throws (installation failed, or this
 * process was already a restart and is therefore stuck in a loop).
 */
export function switchGlobalCli(spec: string, relaunchArgs: string[]): never {
  if (wasRelaunched()) {
    throw new Error(
      `Could not switch to ${spec}: this process was already restarted after a reinstall, ` +
        `but is still running version ${cliVersion()}. Install manually: npm install -g ${spec}`,
    );
  }
  console.log(bold(`Switching CLI to ${spec}`));
  console.log(dim(`Current version: ${cliVersion()}`));
  try {
    execSync(`npm install -g ${spec}`, { stdio: 'inherit' });
  } catch {
    throw new Error(`Could not install ${spec}. Is the package published and reachable?`);
  }
  relaunchCli(relaunchArgs);
}

/** True when this process is already a restart after a self-update. */
function wasRelaunched(): boolean {
  return process.env[RELAUNCH_ENV] === '1';
}

/** Restarts the (just installed) global CLI with the given arguments. */
function relaunchCli(args: string[]): never {
  console.log(dim(`Restarting: huddle ${args.join(' ')}`));
  const env = { ...process.env, [RELAUNCH_ENV]: '1' };
  const entry = resolveGlobalEntry();
  const result = entry
    ? spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit', env })
    : spawnSync('huddle', args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  process.exit(result.status ?? 1);
}

function resolveGlobalEntry(): string | undefined {
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const entry = path.join(root, ...CLI_PACKAGE.split('/'), 'dist', 'index.js');
    return fs.existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}
