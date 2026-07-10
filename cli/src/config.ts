import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Local Huddle configuration in ~/.huddle/config.json. Among other things we
 * remember which experiment is active here, so every subsequent `huddle init`
 * keeps running on the same channel until the user explicitly resets.
 */
export interface HuddleConfig {
  channel?: 'stable' | 'experiment';
  experiment?: number;
}

const CONFIG_DIR = path.join(os.homedir(), '.huddle');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export function configPath(): string {
  return CONFIG_PATH;
}

export function readConfig(): HuddleConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as HuddleConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: HuddleConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

/** Active experiment number, or undefined when running on stable. */
export function activeExperiment(): number | undefined {
  const cfg = readConfig();
  if (cfg.channel === 'experiment' && Number.isInteger(cfg.experiment) && (cfg.experiment as number) > 0) {
    return cfg.experiment;
  }
  return undefined;
}

/** Docker image tag that belongs to the active channel. */
export function imageTag(): string {
  const experiment = activeExperiment();
  return experiment !== undefined ? `experiment-${experiment}` : 'latest';
}
