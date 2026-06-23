#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const api_1 = require("./api");
const start_1 = require("./start");
const firewall_1 = require("./firewall");
const VALUE_FLAGS = new Set(['url', 'ide', 'name', 'image', 'workspace', 'container', 'status']);
const BOOLEAN_FLAGS = new Set(['help', 'h', 'empty', 'i', 'interactive']);
const COMMANDS = new Set(['start', 'firewall', 'fw', 'help']);
function parseArgs(argv) {
    const positional = [];
    const flags = {};
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
            if (!name)
                throw new Error(`Ongeldige optie: ${arg}`);
            if (eq >= 0) {
                flags[name] = raw.slice(eq + 1);
            }
            else if (VALUE_FLAGS.has(name)) {
                const next = argv[i + 1];
                if (next === undefined || next.startsWith('-')) {
                    throw new Error(`Optie --${name} verwacht een waarde`);
                }
                flags[name] = next;
                i++;
            }
            else {
                flags[name] = true;
            }
            continue;
        }
        if (arg.startsWith('-') && arg !== '-') {
            const raw = arg.slice(1);
            if ([...raw].every((c) => BOOLEAN_FLAGS.has(c))) {
                for (const c of raw)
                    flags[c] = true;
            }
            else if (raw.length === 1 && VALUE_FLAGS.has(raw)) {
                const next = argv[i + 1];
                if (next === undefined || next.startsWith('-')) {
                    throw new Error(`Optie -${raw} verwacht een waarde`);
                }
                flags[raw] = next;
                i++;
            }
            else {
                throw new Error(`Onbekende optie: ${arg}`);
            }
            continue;
        }
        positional.push(arg);
    }
    return { positional, flags };
}
function printHelp() {
    console.log(`
Gebruik:
  huddle [opties] [folder]           Devcontainer starten in huidige map of folder
  huddle start [opties] [folder]     Expliciet een devcontainer starten
  huddle firewall list [opties]      Firewall-verzoeken weergeven
  huddle fw list [opties]            Alias voor firewall list

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
async function main() {
    let parsed;
    try {
        parsed = parseArgs(process.argv.slice(2));
    }
    catch (err) {
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
    (0, api_1.setBaseUrl)(url);
    const startsWithExistingPath = cmd !== undefined && !COMMANDS.has(cmd) && fs_1.default.existsSync(path_1.default.resolve(cmd));
    if (!cmd || cmd === 'start' || startsWithExistingPath) {
        const startArgs = cmd === 'start' ? positional.slice(1) : startsWithExistingPath ? positional : [];
        if (startArgs.length > 1 && !flagString(flags, 'workspace')) {
            throw new Error(`Te veel start-argumenten: ${startArgs.slice(1).join(' ')}`);
        }
        await (0, start_1.runStart)({
            ide: flagString(flags, 'ide') ?? 'intellij',
            workspace: flagString(flags, 'workspace') ?? startArgs[0],
            name: flagString(flags, 'name'),
            image: flagString(flags, 'image'),
            empty: flagBool(flags, 'empty'),
        });
        return;
    }
    if (cmd === 'firewall' || cmd === 'fw') {
        const subCmd = sub ?? 'list';
        if (subCmd !== 'list') {
            console.error(`Onbekend firewall-subcommando: ${subCmd}`);
            process.exit(1);
        }
        await (0, firewall_1.runFirewallList)({
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
function flagString(flags, ...names) {
    for (const name of names) {
        const value = flags[name];
        if (typeof value === 'string')
            return value;
    }
    return undefined;
}
function flagBool(flags, ...names) {
    return names.some((name) => flags[name] === true);
}
main().catch((err) => {
    console.error(`Fout: ${err.message ?? err}`);
    process.exit(1);
});
