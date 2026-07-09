import { green, bold, dim, yellow } from './utils';
import { activeExperiment, configPath, readConfig, writeConfig } from './config';
import { CLI_PACKAGE, cliVersion, installGlobalCli, relaunchCli, wasRelaunched } from './self-update';
import { runInit, InitOptions } from './init';

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

  const spec = wanted !== undefined ? `${CLI_PACKAGE}@experiment-${wanted}` : `${CLI_PACKAGE}@latest`;
  if (wasRelaunched()) {
    throw new Error(
      `CLI-versie (${cliVersion()}) hoort na herinstallatie nog steeds niet bij het ` +
        `geconfigureerde kanaal (${wanted !== undefined ? `experiment ${wanted}` : 'stable'}). ` +
        `Controleer ${configPath()} of installeer handmatig: npm install -g ${spec}`,
    );
  }

  console.log(bold(`CLI wisselen naar ${spec}`));
  console.log(dim(`Huidige versie: ${cliVersion()}`));
  try {
    installGlobalCli(spec);
  } catch {
    throw new Error(
      `Kon ${spec} niet installeren. Bestaat het experiment en heb je toegang tot ` +
        `npm.pkg.github.com? Met "huddle experiment reset" ga je terug naar stable.`,
    );
  }
  relaunchCli(relaunchArgs);
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
  if (cliExperiment() !== experiment) {
    console.log(
      yellow(
        '[!] CLI-versie hoort niet bij het geconfigureerde kanaal; ' +
          'de eerstvolgende "huddle init" herstelt dit automatisch.',
      ),
    );
  }
}
