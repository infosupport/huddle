// Turning a sudo log line into an audit row.
//
// Devcontainers tail /tmp/sudo-audit.log and POST each new line to Huddle (see
// the forwarder in docker.ts). The line is written by sudo itself and looks
// like:
//
//   Aug 27 11:02:31 : vscode : TTY=pts/0 ; PWD=/workspace ; USER=root ;
//   COMMAND=/usr/bin/apt-get install curl
//
// Dependency-free on purpose: the entry crosses the control channel as text, so
// the half that parses it is the half that owns the database, and this module
// must not drag one in to be testable.

export interface SudoAuditRow {
  /** `sudo:<command>` — what the audit list groups on. */
  action: string;
  /** The full command, bounded. */
  path: string;
}

/** How much of a command is kept. The column is not a place to store a script. */
const MAX_COMMAND = 200;

export function parseSudoEntry(entry: string): SudoAuditRow | null {
  const trimmed = (entry ?? '').trim();
  if (!trimmed) return null;

  // Everything after COMMAND= is the command, spaces and all. No match means
  // sudo logged something else (an auth failure, say) — keep the whole line
  // rather than dropping it, because those are the interesting ones.
  const cmdMatch = trimmed.match(/COMMAND=(.+)$/);
  const cmd = cmdMatch ? cmdMatch[1].trim() : trimmed;
  // First word, THEN its basename — in that order. The other way round takes the
  // last slash in the whole line, so `sudo cat /etc/shadow` files itself under
  // `sudo:shadow` and the audit list groups by the victim instead of the tool.
  const cmdBase = cmd.split(/\s+/)[0].split('/').pop() || 'unknown';

  return {
    action: `sudo:${cmdBase || 'unknown'}`,
    path: cmd.length > MAX_COMMAND ? cmd.slice(0, MAX_COMMAND) : cmd,
  };
}
