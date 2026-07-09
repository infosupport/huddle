import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { bold, green, dim, yellow } from './utils';
import { activeExperiment, configPath, readConfig, writeConfig } from './config';
import { runInit, InitOptions } from './init';

const PACKAGE = '@infosupport/huddle-cli';

// Guard tegen een herstart-loop: als we na een zelf-upgrade opnieuw opstarten
// en de versie klopt dan nóg niet, stoppen we met een foutmelding in plaats
// van eindeloos opnieuw te installeren.
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
 * Experiment-nummer dat in de versie van deze CLI-build is gebakken.
 * Experimentele builds krijgen van de pipeline een versie als
 * `0.0.0-experiment-123.42`; stabiele releases matchen hier niet.
 */
export function cliExperiment(): number | undefined {
  const match = cliVersion().match(/-experiment-(\d+)\./);
  return match ? Number(match[1]) : undefined;
}

export function parseIssueNumber(raw: string | undefined): number {
  const issue = Number(raw);
  if (!raw || !Number.isInteger(issue) || issue <= 0) {
    throw new Error(`Ongeldig issue-nummer: ${raw ?? '(leeg)'}. Gebruik bv. "huddle experiment use 123".`);
  }
  return issue;
}

/**
 * Zorgt dat het draaiende CLI-proces bij het geconfigureerde kanaal hoort.
 * Wijkt de versie af, dan installeren we de juiste versie globaal en herstarten
 * we onszelf met relaunchArgs; in dat geval keert deze functie niet terug
 * (process.exit met de exitcode van het nieuwe proces).
 */
export function ensureCliForChannel(relaunchArgs: string[]): void {
  const wanted = activeExperiment();
  const current = cliExperiment();
  if (wanted === current) return;

  if (process.env[RELAUNCH_ENV] === '1') {
    throw new Error(
      `CLI-versie (${cliVersion()}) hoort na herinstallatie nog steeds niet bij het ` +
        `geconfigureerde kanaal (${wanted !== undefined ? `experiment ${wanted}` : 'stable'}). ` +
        `Controleer ${configPath()} of installeer handmatig: npm install -g ${PACKAGE}@${wanted !== undefined ? `experiment-${wanted}` : 'latest'}`,
    );
  }

  const spec = wanted !== undefined ? `${PACKAGE}@experiment-${wanted}` : `${PACKAGE}@latest`;
  console.log(bold(`CLI wisselen naar ${spec}`));
  console.log(dim(`Huidige versie: ${cliVersion()}`));
  try {
    execSync(`npm install -g ${spec}`, { stdio: 'inherit' });
  } catch {
    throw new Error(
      `Kon ${spec} niet installeren. Bestaat het experiment en heb je toegang tot ` +
        `npm.pkg.github.com? Met "huddle experiment reset" ga je terug naar stable.`,
    );
  }
  relaunch(relaunchArgs);
}

/** Herstart de (zojuist geïnstalleerde) globale CLI met de gegeven argumenten. */
function relaunch(args: string[]): never {
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
    const entry = path.join(root, ...PACKAGE.split('/'), 'dist', 'index.js');
    return fs.existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Activeert een experiment en voert daarna init uit. Dit is het gedeelde pad
 * achter `huddle experiment use <nr>` en `huddle init --experiment <nr>`.
 */
export async function runExperimentUse(issue: number, initOpts: InitOptions = {}): Promise<void> {
  const previous = readConfig();
  writeConfig({ ...previous, channel: 'experiment', experiment: issue });
  console.log(green(`Experiment ${issue} geactiveerd`) + dim(` (${configPath()})`));

  const relaunchArgs = ['init', ...(initOpts.runtime ? ['--runtime', initOpts.runtime] : [])];
  try {
    ensureCliForChannel(relaunchArgs);
  } catch (err) {
    // Activatie mislukt → config terugdraaien zodat een volgende `huddle init`
    // niet blijft hangen op een niet-installeerbaar experiment.
    writeConfig(previous);
    throw err;
  }
  await runInit(initOpts);
}

/** Zet Huddle terug naar de stabiele release. */
export async function runExperimentReset(): Promise<void> {
  const config = readConfig();
  if (activeExperiment() === undefined && cliExperiment() === undefined) {
    console.log('Geen experiment actief; Huddle draait al op stable.');
    return;
  }

  delete config.experiment;
  config.channel = 'stable';
  writeConfig(config);
  console.log(green('Experiment-config verwijderd') + dim(` (${configPath()})`));

  // Draait er nog een experimentele CLI, dan installeert dit de stabiele versie
  // en herstart de nieuwe CLI zichzelf om de status te tonen.
  ensureCliForChannel(['experiment', 'status']);
  runExperimentStatus();
}

export function runExperimentStatus(): void {
  const experiment = activeExperiment();
  console.log(`CLI-versie:  ${cliVersion()}`);
  if (experiment !== undefined) {
    console.log(`Kanaal:      experiment ${experiment} (images: experiment-${experiment})`);
    console.log(dim('Terug naar stable: huddle experiment reset'));
  } else {
    console.log('Kanaal:      stable (images: latest)');
  }
  const mismatch = cliExperiment() !== experiment;
  if (mismatch) {
    console.log(
      yellow(
        '[!] CLI-versie hoort niet bij het geconfigureerde kanaal; ' +
          'de eerstvolgende "huddle init" herstelt dit automatisch.',
      ),
    );
  }
}
