import { green, dim, yellow } from './utils';
import { activeExperiment, configPath, readConfig, writeConfig } from './config';
import { CLI_PACKAGE, cliVersion, switchGlobalCli } from './self-update';
import { resolveImages } from './images';
import { runInit, InitOptions } from './init';

/**
 * Experiment number baked into the version of this CLI build.
 * Experimental builds get a version like `0.0.0-experiment-123.42` from the
 * pipeline; stable releases don't match here.
 */
export function cliExperiment(): number | undefined {
  const match = cliVersion().match(/-experiment-(\d+)\./);
  return match ? Number(match[1]) : undefined;
}

export function parseIssueNumber(raw: string | undefined): number {
  const issue = Number(raw);
  if (!raw || !Number.isInteger(issue) || issue <= 0) {
    throw new Error(`Invalid issue/PR number: ${raw ?? '(empty)'}. Use e.g. "huddle experiment use 123".`);
  }
  return issue;
}

/**
 * Ensures the running CLI process belongs to the configured channel.
 * This function only determines which version should be running; the switch
 * itself (install + restart) is done by self-update.ts. On a switch this
 * function does not return (process.exit with the exit code of the new process).
 */
export function ensureCliForChannel(relaunchArgs: string[]): void {
  const wanted = activeExperiment();
  if (wanted === cliExperiment()) return;

  const spec = wanted !== undefined ? `${CLI_PACKAGE}@experiment-${wanted}` : `${CLI_PACKAGE}@latest`;
  try {
    switchGlobalCli(spec, relaunchArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message} Use "huddle experiment reset" to go back to stable (config: ${configPath()}).`);
  }
}

/**
 * Activates an experiment and then runs init. This is the shared path behind
 * `huddle experiment use <nr>` and `huddle init --experiment <nr>`.
 */
export async function runExperimentUse(issue: number, initOpts: InitOptions = {}): Promise<void> {
  const previous = readConfig();
  writeConfig({ ...previous, channel: 'experiment', experiment: issue });
  console.log(green(`Experiment ${issue} activated`) + dim(` (${configPath()})`));

  const relaunchArgs = ['init', ...(initOpts.runtime ? ['--runtime', initOpts.runtime] : [])];
  try {
    ensureCliForChannel(relaunchArgs);
  } catch (err) {
    // Activation failed → roll back the config so a subsequent `huddle init`
    // doesn't stay stuck on an experiment that cannot be installed.
    writeConfig(previous);
    throw err;
  }
  await runInit(initOpts, resolveImages());
}

/** Puts Huddle back on the stable release. */
export async function runExperimentReset(): Promise<void> {
  const config = readConfig();
  if (activeExperiment() === undefined && cliExperiment() === undefined) {
    console.log('No experiment active; Huddle is already running on stable.');
    return;
  }

  delete config.experiment;
  config.channel = 'stable';
  writeConfig(config);
  console.log(green('Experiment config removed') + dim(` (${configPath()})`));

  // If an experimental CLI is still running, this installs the stable version
  // and the new CLI restarts itself to show the status.
  ensureCliForChannel(['experiment', 'status']);
  runExperimentStatus();
}

export function runExperimentStatus(): void {
  const experiment = activeExperiment();
  console.log(`CLI version: ${cliVersion()}`);
  if (experiment !== undefined) {
    console.log(`Channel:     experiment ${experiment} (images: experiment-${experiment})`);
    console.log(dim('Back to stable: huddle experiment reset'));
  } else {
    console.log('Channel:     stable (images: latest)');
  }
  if (cliExperiment() !== experiment) {
    console.log(
      yellow(
        '[!] CLI version does not belong to the configured channel; ' +
          'the next "huddle init" fixes this automatically.',
      ),
    );
  }
}
