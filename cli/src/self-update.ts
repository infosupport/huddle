import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { bold, dim } from './utils';

/**
 * Infrastructuur voor zelf-updates van de CLI: versie-informatie van de eigen
 * build, globale (her)installatie via npm en het herstarten van het eigen
 * proces. Welke versie er geïnstalleerd moet worden (stable of experiment) is
 * een domeinbeslissing en leeft in experiment.ts.
 */

export const CLI_PACKAGE = '@infosupport/huddle-cli';

// Guard tegen een herstart-loop: gezet bij een relaunch, zodat de nieuwe CLI
// niet opnieuw gaat installeren wanneer de versie dan nóg niet klopt.
const RELAUNCH_ENV = 'HUDDLE_EXPERIMENT_RELAUNCHED';

export function cliVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return String(pkg.version ?? 'onbekend');
  } catch {
    return 'onbekend';
  }
}

/**
 * Wisselt de globale CLI naar de gegeven package-spec en herstart daarna dit
 * proces met relaunchArgs. Keert nooit terug: het proces eindigt met de
 * exitcode van de nieuwe CLI, of deze functie gooit een fout (installatie
 * mislukt, of dit proces was zelf al een herstart en zit dus in een loop).
 */
export function switchGlobalCli(spec: string, relaunchArgs: string[]): never {
  if (wasRelaunched()) {
    throw new Error(
      `Kon niet wisselen naar ${spec}: dit proces is al herstart na een herinstallatie, ` +
        `maar draait nog steeds versie ${cliVersion()}. Installeer handmatig: npm install -g ${spec}`,
    );
  }
  console.log(bold(`CLI wisselen naar ${spec}`));
  console.log(dim(`Huidige versie: ${cliVersion()}`));
  try {
    execSync(`npm install -g ${spec}`, { stdio: 'inherit' });
  } catch {
    throw new Error(`Kon ${spec} niet installeren. Ben je ingelogd op npm.pkg.github.com?`);
  }
  relaunchCli(relaunchArgs);
}

/** True wanneer dit proces al een herstart na een zelf-update is. */
function wasRelaunched(): boolean {
  return process.env[RELAUNCH_ENV] === '1';
}

/** Herstart de (zojuist geïnstalleerde) globale CLI met de gegeven argumenten. */
function relaunchCli(args: string[]): never {
  console.log(dim(`Herstart: huddle ${args.join(' ')}`));
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
