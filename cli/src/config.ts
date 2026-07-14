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
  // Operator-token voor de control-plane-auth. Door `huddle init` gegenereerd en
  // hier bewaard zodat volgende CLI-commando's zich als operator kunnen
  // authenticeren (Authorization: Bearer). Env HUDDLE_OPERATOR_TOKEN wint.
  operatorToken?: string;
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

/** Operator-token voor API-auth: env wint, anders uit de config. */
export function operatorToken(): string | undefined {
  const env = process.env.HUDDLE_OPERATOR_TOKEN?.trim();
  if (env) return env;
  const t = readConfig().operatorToken;
  return t && t.trim() ? t.trim() : undefined;
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
