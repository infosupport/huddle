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
const BOOLEAN_FLAGS = new Set(['help', 'h', 'empty', 'i', 'interactive', 'version', 'v']);
const COMMANDS = new Set(['start', 'firewall', 'fw', 'init', 'help', 'version']);

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
      if (!name) throw new Error(`Invalid option: ${arg}`);

      if (eq >= 0) {
        flags[name] = raw.slice(eq + 1);
      } else if (VALUE_FLAGS.has(name)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          throw new Error(`Option --${name} expects a value`);
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
          throw new Error(`Option -${raw} expects a value`);
        }
        flags[raw] = next;
        i++;
      } else {
        throw new Error(`Unknown option: ${arg}`);
      }
      continue;
    }

    positional.push(arg);
  }

  return { positional, flags };
}

function readVersion(): string {
  // npm always includes package.json in the published tarball, and it holds the
  // version published by CI (GitVersion) to the packages registry.
  // dist/index.js -> ../package.json.
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string') return pkg.version;
  } catch {
    // fall back to 'unknown' below
  }
  return 'unknown';
}

function printHelp(): void {
  console.log(`
Usage:
  huddle [options] [folder]          Start a devcontainer in the current or given folder
  huddle start [options] [folder]    Explicitly start a devcontainer
  huddle init [options]              Pull the Huddle + devcontainer base images and
                                     start them via Docker or Podman
  huddle firewall list [options]     Show firewall requests
  huddle fw list [options]           Alias for firewall list

Init options:
  --runtime <docker|podman>          Container runtime (default: auto-detected;
                                     also via the HUDDLE_RUNTIME env var)

Start options:
  --ide <intellij|rider|vscode>      IDE (default: intellij)
  --workspace <path>                 Workspace directory (default: current directory)
  --name <name>                      Container name (default: devcontainer-<foldername>)
  --image <image>                    Use a specific image
  --empty                            Empty container without a workspace

Firewall options:
  -i, --interactive                  Interactively approve/deny
  --container <name>                 Filter by container
  --status <requested|allow|deny>    Filter by status (default: requested)

Global options:
  --url <url>                        Huddle URL (default: http://localhost:3000)
                                     Or via the HUDDLE_URL env var
  --help, -h                         Show help
  --version, -v                      Show version (as published to
                                     GitHub packages)
`);
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Run "huddle --help" for help.');
    process.exit(1);
  }

  const { positional, flags } = parsed;
  const [cmd, sub] = positional;

  if (flagBool(flags, 'version', 'v') || cmd === 'version') {
    console.log(readVersion());
    return;
  }

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
      throw new Error(`Too many start arguments: ${startArgs.slice(1).join(' ')}`);
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
      console.error(`Unknown firewall subcommand: ${subCmd}`);
      process.exit(1);
    }
    await runFirewallList({
      interactive: flagBool(flags, 'i', 'interactive'),
      container: flagString(flags, 'container'),
      status: flagString(flags, 'status'),
    });
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  console.error('Run "huddle --help" for help.');
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
  console.error(`Error: ${err.message ?? err}`);
  if (err instanceof ApiError && err.message.includes('Cannot reach Huddle API')) {
    console.error('\nHuddle does not appear to be running. Start it with:\n  huddle init');
  }
  process.exit(1);
});
