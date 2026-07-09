import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Lokale Huddle-configuratie in ~/.huddle/config.json. Hier onthouden we o.a.
 * welk experiment actief is, zodat elke volgende `huddle init` op hetzelfde
 * kanaal blijft draaien totdat de gebruiker expliciet reset.
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

/** Actief experiment-nummer, of undefined wanneer we op stable draaien. */
export function activeExperiment(): number | undefined {
  const cfg = readConfig();
  if (cfg.channel === 'experiment' && Number.isInteger(cfg.experiment) && (cfg.experiment as number) > 0) {
    return cfg.experiment;
  }
  return undefined;
}

/** Docker-image-tag die bij het actieve kanaal hoort. */
export function imageTag(): string {
  const experiment = activeExperiment();
  return experiment !== undefined ? `experiment-${experiment}` : 'latest';
}
