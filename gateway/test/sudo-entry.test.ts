import { describe, it, expect } from 'vitest';

import { parseSudoEntry } from '../src/control/sudo-entry';

// Pure, so this runs everywhere — including the devcontainer where the native
// SQLite binding cannot be built. That matters: this parser sees a line a
// devcontainer's forwarder chose to send, so it is attacker-influenced input on
// its way into the audit log.
describe('parseSudoEntry', () => {
  const LINE =
    'Aug 27 11:02:31 : vscode : TTY=pts/0 ; PWD=/workspace ; USER=root ; COMMAND=/usr/bin/apt-get install curl';

  it('takes everything after COMMAND= as the command, and its basename as the action', () => {
    expect(parseSudoEntry(LINE)).toEqual({
      action: 'sudo:apt-get',
      path: '/usr/bin/apt-get install curl',
    });
  });

  it('keeps the whole line when sudo logged something other than a command', () => {
    // Auth failures have no COMMAND= — and they are the interesting ones, so
    // they are kept rather than dropped.
    const denied = 'Aug 27 11:02:31 : vscode : user NOT in sudoers ; TTY=pts/0 ; PWD=/ ; USER=root';
    const row = parseSudoEntry(denied);
    expect(row?.path).toBe(denied);
    expect(row?.action).toBe('sudo:Aug');
  });

  it('rejects an empty or whitespace-only entry', () => {
    expect(parseSudoEntry('')).toBeNull();
    expect(parseSudoEntry('   \n\t ')).toBeNull();
    expect(parseSudoEntry(undefined as unknown as string)).toBeNull();
  });

  it('bounds the command — the column is not a place to store a script', () => {
    const row = parseSudoEntry(`COMMAND=/bin/sh -c ${'a'.repeat(5000)}`);
    expect(row?.path.length).toBe(200);
    expect(row?.action).toBe('sudo:sh');
  });

  it('does not let a trailing path segment become the action', () => {
    // The basename is taken from the FIRST word, not from the last slash in the
    // line — otherwise `sudo cat /etc/shadow` would file itself as `sudo:shadow`.
    expect(parseSudoEntry('COMMAND=/usr/bin/cat /etc/shadow')?.action).toBe('sudo:cat');
  });

  it('survives a line with no command name at all', () => {
    expect(parseSudoEntry('COMMAND=/')?.action).toBe('sudo:unknown');
  });
});
