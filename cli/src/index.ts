#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { setBaseUrl, ApiError } from './api';
import { runStart } from './start';
import { runFirewallList } from './firewall';
import { runInit } from './init';

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set(['url', 'ide', 'name', 'image', 'workspace', 'container', 'status', 'runtime']);
const BOOLEAN_FLAGS = new Set(['help', 'h', 'empty', 'i', 'interactive']);
const COMMANDS = new Set(['start', 'firewall', 'fw', 'init', 'help']);

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const raw = arg.slice(2);
      const eq = raw.indexOf('=');
      const name = eq >= 0 ? raw.slice(0, eq) : raw;
      if (!name) throw new Error(`Ongeldige optie: ${arg}`);

      if (eq >= 0) {
        flags[name] = raw.slice(eq + 1);
      } else if (VALUE_FLAGS.has(name)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          throw new Error(`Optie --${name} verwacht een waarde`);
        }
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
      continue;
    }

    if (arg.startsWith('-') && arg !== '-') {
      const raw = arg.slice(1);
      if ([...raw].every((c) => BOOLEAN_FLAGS.has(c))) {
        for (const c of raw) flags[c] = true;
      } else if (raw.length === 1 && VALUE_FLAGS.has(raw)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          throw new Error(`Optie -${raw} verwacht een waarde`);
        }
        flags[raw] = next;
        i++;
      } else {
        throw new Error(`Onbekende optie: ${arg}`);
      }
      continue;
    }

    positional.push(arg);
  }

  return { positional, flags };
}

function printHelp(): void {
  console.log(`
Gebruik:
  huddle [opties] [folder]           Devcontainer starten in huidige map of folder
  huddle start [opties] [folder]     Expliciet een devcontainer starten
  huddle init [opties]               Huddle + devcontainer base-images pullen en
                                     opstarten via Docker of Podman
  huddle firewall list [opties]      Firewall-verzoeken weergeven
  huddle fw list [opties]            Alias voor firewall list

Init opties:
  --runtime <docker|podman>          Container runtime (standaard: automatisch
                                     gedetecteerd; ook via env-var HUDDLE_RUNTIME)

Start opties:
  --ide <intellij|rider|vscode>      IDE (standaard: intellij)
  --workspace <pad>                  Workspace-map (standaard: huidige map)
  --name <naam>                      Containernaam (standaard: devcontainer-<mapnaam>)
  --image <image>                    Specifieke image gebruiken
  --empty                            Lege container zonder workspace

Firewall opties:
  -i, --interactive                  Interactief goedkeuren/weigeren
  --container <naam>                 Filter op container
  --status <requested|allow|deny>    Filter op status (standaard: requested)

Globale opties:
  --url <url>                        Huddle URL (standaard: http://localhost:3000)
                                     Of via env-var HUDDLE_URL
  --help, -h                         Help weergeven
`);
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Fout: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Gebruik "huddle --help" voor hulp.');
    process.exit(1);
  }

  const { positional, flags } = parsed;
  const [cmd, sub] = positional;

  if (flagBool(flags, 'help', 'h') || cmd === 'help') {
    printHelp();
    return;
  }

  const url = flagString(flags, 'url') ?? process.env.HUDDLE_URL ?? 'http://localhost:3000';
  setBaseUrl(url);

  const startsWithExistingPath = cmd !== undefined && !COMMANDS.has(cmd) && fs.existsSync(path.resolve(cmd));
  if (!cmd || cmd === 'start' || startsWithExistingPath) {
    const startArgs = cmd === 'start' ? positional.slice(1) : startsWithExistingPath ? positional : [];
    if (startArgs.length > 1 && !flagString(flags, 'workspace')) {
      throw new Error(`Te veel start-argumenten: ${startArgs.slice(1).join(' ')}`);
    }

    await runStart({
      ide: flagString(flags, 'ide') ?? 'intellij',
      workspace: flagString(flags, 'workspace') ?? startArgs[0],
      name: flagString(flags, 'name'),
      image: flagString(flags, 'image'),
      empty: flagBool(flags, 'empty'),
    });
    return;
  }

  if (cmd === 'init') {
    await runInit({ runtime: flagString(flags, 'runtime') });
    return;
  }

  if (cmd === 'firewall' || cmd === 'fw') {
    const subCmd = sub ?? 'list';
    if (subCmd !== 'list') {
      console.error(`Onbekend firewall-subcommando: ${subCmd}`);
      process.exit(1);
    }
    await runFirewallList({
      interactive: flagBool(flags, 'i', 'interactive'),
      container: flagString(flags, 'container'),
      status: flagString(flags, 'status'),
    });
    return;
  }

  console.error(`Onbekend commando: ${cmd}`);
  console.error('Gebruik "huddle --help" voor hulp.');
  process.exit(1);
}

function flagString(flags: Record<string, string | boolean>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function flagBool(flags: Record<string, string | boolean>, ...names: string[]): boolean {
  return names.some((name) => flags[name] === true);
}

main().catch((err: Error) => {
  console.error(`Fout: ${err.message ?? err}`);
  if (err instanceof ApiError && err.message.includes('Kan Huddle API niet bereiken')) {
    console.error('\nHuddle lijkt niet te draaien. Start het met:\n  huddle init');
  }
  process.exit(1);
});
