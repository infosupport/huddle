import { describe, it, expect, vi } from 'vitest';

// ── Shell quoting for the container setup script ─────────────────────────────
// docker.ts substitutes the workspace root into a script that is executed inside
// the fresh container as `sh -c` with User: 'root'. The API layer refuses paths
// containing shell metacharacters (containerPathError, workspace-root.test.ts);
// shQuote is the second, independent layer, so a caller that reaches the script
// builders without that validation still cannot inject a command.
//
// docker.ts imports ./db (native better-sqlite3 binding, absent in a fresh
// devcontainer) transitively, so it is mocked here purely to let the module load —
// same as windows-mount-path.test.ts.
vi.mock('../src/db', () => ({
  getSetting: () => null,
  isHostPortApproved: () => false,
  getGrant: () => null,
  getActionPolicy: () => null,
  setSudoGrant: () => {},
  deleteSudoGrant: () => {},
  getExpiredSudoGrants: () => [],
}));

const { shQuote } = await import('../src/docker');

// Run `sh -c "PROJ=<quoted>; printf %s \"$PROJ\""` semantics in-process: what does
// a POSIX shell see as the value of PROJ? Rather than spawning a shell, assert the
// two properties that matter — the result is a single-quoted string, and the only
// unescaped single quotes are its own delimiters.
function isSingleQuotedLiteral(quoted: string): boolean {
  if (!quoted.startsWith("'") || !quoted.endsWith("'")) return false;
  // Inside the delimiters, a single quote may appear only as the exact sequence
  // '\'' — close, escaped quote, reopen.
  return !quoted.slice(1, -1).replace(/'\\''/g, '').includes("'");
}

describe('shQuote', () => {
  it('wraps an ordinary path in single quotes', () => {
    expect(shQuote('/workspaces/api')).toBe("'/workspaces/api'");
  });

  it('leaves shell-active characters inert', () => {
    for (const value of [
      '/workspaces/x"; touch /tmp/pwned; #',
      '/workspaces/$(id)',
      '/workspaces/`id`',
      '/workspaces/$HOME',
      '/workspaces/a\\b',
      '/workspaces/a b',
      '/workspaces/x\ny',
    ]) {
      const quoted = shQuote(value);
      expect(isSingleQuotedLiteral(quoted)).toBe(true);
      // The payload survives verbatim — quoting must not corrupt legitimate paths.
      expect(quoted.slice(1, -1).replace(/'\\''/g, "'")).toBe(value);
    }
  });

  it('closes, escapes and reopens an embedded single quote', () => {
    expect(shQuote("/workspaces/it's")).toBe("'/workspaces/it'\\''s'");
    expect(isSingleQuotedLiteral(shQuote("a'b'c"))).toBe(true);
    expect(isSingleQuotedLiteral(shQuote("'"))).toBe(true);
  });
});
