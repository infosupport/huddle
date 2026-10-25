// ── Host pipe op `tool.run`: allowlisted host binaries, argv only ─────────────
// The gateway can ask the host to run a tool such as Docker Sandboxes (`sbx`).
// Only binaries named in TOOLS can run, always with an argv array and never via
// a shell, so an argument like `$(whoami)` or `& calc` stays a literal string.
// Adding the next environment tool is one entry in TOOLS (plus its provider in
// gateway/src/environments/).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { DEFAULT_TOOL_TIMEOUT_MS, MAX_OUTPUT_BYTES, MAX_TOOL_TIMEOUT_MS, PipeError } from './protocol';

export interface ToolSpec {
  /** File names to look for on PATH, in order. */
  bins: string[];
  /** Env var that overrides the binary (a path, or a name looked up on PATH). */
  env: string;
}

export const TOOLS: Record<string, ToolSpec> = {
  sbx: { bins: ['sbx', 'sbx.exe'], env: 'HUDDLE_SBX_BIN' },
};

export interface ToolRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ResolvedTool = { path: string } | { error: PipeError };

// Windows runs .bat/.cmd through cmd.exe whatever argv we pass, and cmd.exe
// re-parses the command line, so an argument could inject a command. Only real
// executables are accepted.
const REFUSED_EXT = new Set(['.bat', '.cmd']);
const WIN_RUNNABLE_EXT = new Set(['.exe', '.com']);

function isRunnableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Candidate file names for one bin: on Windows `sbx` becomes sbx.COM, sbx.EXE, ... per PATHEXT. */
function candidates(bin: string): string[] {
  if (process.platform !== 'win32' || path.extname(bin)) return [bin];
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return exts.map((ext) => bin + ext.toLowerCase());
}

/**
 * Finds a tool's binary without a shell: the env override if set, otherwise the
 * first runnable match on PATH. A .bat/.cmd hit is skipped, and reported as
 * not_allowed only when nothing else was found.
 */
export function resolveTool(name: string): ResolvedTool {
  const spec = Object.prototype.hasOwnProperty.call(TOOLS, name) ? TOOLS[name] : undefined;
  if (!spec) return { error: new PipeError('not_allowed', `tool '${name}' is not allowlisted on the host`) };

  const override = process.env[spec.env]?.trim();
  const bins = override ? [override] : spec.bins;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  let refused: string | undefined;

  // Every file to try, in order. A bin with a directory in it is a path, not a
  // name to look up on PATH.
  const files = bins
    .flatMap((bin) => (bin.includes('/') || bin.includes('\\') ? [path.resolve(bin)] : dirs.map((d) => path.join(d, bin))))
    .flatMap(candidates);

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    // On Windows, skip batch files (they go through cmd.exe) and non-executables.
    if (process.platform === 'win32' && !WIN_RUNNABLE_EXT.has(ext)) {
      if (REFUSED_EXT.has(ext) && isRunnableFile(file)) refused ??= file;
      continue;
    }
    if (isRunnableFile(file)) return { path: file };
  }

  if (refused) {
    return { error: new PipeError('not_allowed', `refusing to run ${refused}: batch files go through cmd.exe`) };
  }
  const where = override ? `${spec.env}=${override}` : `${spec.bins.join(' / ')} on PATH`;
  return { error: new PipeError('tool_missing', `${name} is not installed on the host (looked for ${where})`) };
}

/**
 * Runs `file` with argv `args`: no shell, stdin closed, no console window, a
 * hard timeout and at most MAX_OUTPUT_BYTES kept per stream (the rest is
 * drained and dropped, so a chatty tool cannot exhaust the agent's memory).
 */
export function execTool(
  file: string,
  args: string[],
  timeoutMs: number,
  maxBytes: number = MAX_OUTPUT_BYTES,
): Promise<ToolRunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (err) {
      reject(err);
      return;
    }

    const collect = () => {
      const chunks: Buffer[] = [];
      let size = 0;
      let dropped = false;
      return {
        push(chunk: Buffer) {
          if (size >= maxBytes) { dropped = true; return; }
          const room = maxBytes - size;
          if (chunk.length > room) { chunk = chunk.subarray(0, room); dropped = true; }
          chunks.push(chunk);
          size += chunk.length;
        },
        text(): string {
          const s = Buffer.concat(chunks).toString('utf8');
          return dropped ? `${s}\n[huddle] output truncated at ${maxBytes} bytes` : s;
        },
      };
    };
    const out = collect();
    const err = collect();
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A tool that ignores SIGTERM still has to go; on Windows kill() is already final.
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    let done = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let stderr = err.text();
      // 124 is what timeout(1) exits with; a signal maps to the shell's 128+n.
      let exit = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1);
      if (timedOut) {
        exit = 124;
        stderr += `${stderr && !stderr.endsWith('\n') ? '\n' : ''}[huddle] timed out after ${timeoutMs} ms`;
      }
      resolve({ code: exit, stdout: out.text(), stderr });
    };
    // 'close' waits for the pipes, which stay open as long as ANY process holds
    // them: a daemon the tool started in the background, or a grandchild that
    // outlived a timeout kill. Once the tool itself has exited, give its output
    // a moment to drain and then stop waiting for the stragglers.
    child.on('exit', (code, signal) => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, 1000);
    });
    child.on('close', finish);
  });
}

/** The `tool.run` op. */
export async function toolRun(args: Record<string, unknown>): Promise<ToolRunResult> {
  const { tool, args: argv, timeoutMs } = args;
  if (typeof tool !== 'string' || !tool) throw new PipeError('bad_request', 'tool must be a non-empty string');
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) {
    throw new PipeError('bad_request', 'args must be an array of strings');
  }
  if (argv.some((a: string) => a.includes('\0'))) throw new PipeError('bad_request', 'args must not contain NUL bytes');
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new PipeError('bad_request', 'timeoutMs must be a positive number');
  }

  const resolved = resolveTool(tool);
  if ('error' in resolved) throw resolved.error;

  const timeout = Math.min(Math.round((timeoutMs as number | undefined) ?? DEFAULT_TOOL_TIMEOUT_MS), MAX_TOOL_TIMEOUT_MS);
  try {
    return await execTool(resolved.path, argv as string[], timeout);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') throw new PipeError('tool_missing', `${tool} disappeared from ${resolved.path}`);
    throw new PipeError('internal', `could not run ${tool}: ${e.message ?? e}`);
  }
}

// One probe per binary path per agent run: `sbx version` can take a moment, and
// host.info is asked for often enough that re-running it every time would show.
const versionCache = new Map<string, Promise<string | undefined>>();

/** First line of `<tool> version`, best effort (undefined on any failure). */
export function toolVersion(file: string): Promise<string | undefined> {
  let cached = versionCache.get(file);
  if (!cached) {
    cached = execTool(file, ['version'], 5000, 64 * 1024)
      .then((r) => (r.code === 0 ? (r.stdout || r.stderr).trim().split(/\r?\n/)[0] || undefined : undefined))
      .catch(() => undefined);
    versionCache.set(file, cached);
  }
  return cached;
}

export interface ToolInfo {
  available: boolean;
  path?: string;
  version?: string;
}

/** Availability of every allowlisted tool, for host.info. */
export async function toolsInfo(): Promise<Record<string, ToolInfo>> {
  const out: Record<string, ToolInfo> = {};
  await Promise.all(
    Object.keys(TOOLS).map(async (name) => {
      const r = resolveTool(name);
      if ('error' in r) {
        out[name] = { available: false };
        return;
      }
      const version = await toolVersion(r.path);
      out[name] = version ? { available: true, path: r.path, version } : { available: true, path: r.path };
    }),
  );
  return out;
}

/** Names of the allowlisted tools that are installed, for the heartbeat. */
export function availableTools(): string[] {
  return Object.keys(TOOLS).filter((name) => !('error' in resolveTool(name)));
}
