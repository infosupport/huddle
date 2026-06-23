"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runStart = runStart;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const api_1 = require("./api");
const utils_1 = require("./utils");
async function runStart(opts) {
    const ide = parseIde(opts.ide);
    const workspaceDir = opts.empty ? undefined : resolveWorkspace(opts.workspace);
    const baseName = opts.empty ? 'empty' : path_1.default.basename(workspaceDir);
    const containerName = opts.name ? validateContainerName(opts.name) : defaultContainerName(baseName);
    console.log(`Starting ${(0, utils_1.bold)(containerName)} with ${(0, utils_1.bold)(ide)}...`);
    if (workspaceDir)
        console.log((0, utils_1.dim)(`Workspace: ${workspaceDir}`));
    let imageName = opts.image;
    if (!imageName) {
        const res = await (0, api_1.get)(`/api/docker/base-image?ide=${encodeURIComponent(ide)}`);
        imageName = res.imageName;
        console.log((0, utils_1.dim)(`Image: ${imageName}`));
    }
    const body = {
        imageName,
        containerName,
        ideName: ide,
    };
    if (opts.empty) {
        body.empty = true;
    }
    else {
        body.workspaceDir = workspaceDir;
    }
    const result = await (0, api_1.post)('/api/docker/start', body);
    console.log((0, utils_1.green)(`[OK] Container gestart: ${result.containerName} (${result.id.slice(0, 12)})`));
    console.log();
    if (ide === 'vscode') {
        console.log(`Open in VS Code: ${(0, utils_1.cyan)('Dev Containers: Attach to Running Container')} -> ${(0, utils_1.bold)(result.containerName)}`);
        return;
    }
    console.log(`Open in JetBrains Gateway: ${(0, utils_1.cyan)('Remote Development > Dev Containers')} -> ${(0, utils_1.bold)(result.containerName)}`);
    await tryPrintIdeLink(result.containerName);
}
async function tryPrintIdeLink(containerName) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
        const res = await (0, api_1.get)(`/api/docker/containers/${encodeURIComponent(containerName)}/ide-link`);
        if (res?.link)
            console.log((0, utils_1.dim)(`Gateway-link: ${res.link}`));
    }
    catch {
        // The IDE link is best-effort; JetBrains may still be starting the backend.
    }
}
function resolveWorkspace(workspace) {
    const resolved = path_1.default.resolve(workspace ?? process.cwd());
    let stat;
    try {
        stat = fs_1.default.statSync(resolved);
    }
    catch {
        throw new Error(`Workspace-map bestaat niet: ${resolved}`);
    }
    if (!stat.isDirectory()) {
        throw new Error(`Workspace-pad is geen map: ${resolved}`);
    }
    return resolved.replace(/[\\/]+$/, '');
}
function defaultContainerName(baseName) {
    const slug = baseName.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[_.-]+|[_.-]+$/g, '');
    return `devcontainer-${slug || 'workspace'}`;
}
function validateContainerName(name) {
    const trimmed = name.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(trimmed)) {
        throw new Error(`Ongeldige containernaam: ${name}`);
    }
    return trimmed;
}
function parseIde(value) {
    const normalized = value.toLowerCase().replace(/[ _-]+/g, '');
    if (normalized === 'rider')
        return 'rider';
    if (normalized === 'vscode' || normalized === 'code')
        return 'vscode';
    if (normalized === 'intellij' || normalized === 'intelij' || normalized === 'idea')
        return 'intellij';
    throw new Error(`Onbekende IDE: ${value}. Kies intellij, rider of vscode.`);
}
