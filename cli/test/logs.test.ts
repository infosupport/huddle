import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { tailFile, parseLines } from '../src/logs';

// node.log is appended to across every restart and never rotated, so the tail
// reader is the part of `huddle logs` that has to be right: it reads backwards
// from the end rather than loading a log that has been growing for weeks.

const made: string[] = [];

function tmpLog(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-logs-'));
  made.push(dir);
  const file = path.join(dir, 'node.log');
  fs.writeFileSync(file, content);
  return file;
}

afterEach(() => {
  while (made.length) fs.rmSync(made.pop()!, { recursive: true, force: true });
});

describe('tailFile', () => {
  it('returns the last N lines', () => {
    const file = tmpLog('a\nb\nc\nd\n');
    expect(tailFile(file, 2)).toBe('c\nd');
    expect(tailFile(file, 1)).toBe('d');
  });

  it('returns the whole file when it is shorter than N', () => {
    expect(tailFile(tmpLog('a\nb\n'), 100)).toBe('a\nb');
  });

  it('handles a file with no trailing newline', () => {
    expect(tailFile(tmpLog('a\nb'), 1)).toBe('b');
  });

  it('handles an empty file', () => {
    expect(tailFile(tmpLog(''), 10)).toBe('');
  });

  it('reads across chunk boundaries on a large file', () => {
    // Well past the 64 KiB read chunk, so the backwards loop has to run more
    // than once and stitch the pieces together in the right order.
    const lines = Array.from({ length: 50_000 }, (_, i) => `line ${i + 1}`);
    const file = tmpLog(lines.join('\n') + '\n');
    expect(tailFile(file, 3)).toBe('line 49998\nline 49999\nline 50000');
    expect(tailFile(file, 50_000)).toBe(lines.join('\n'));
  });

  it('reports a missing file as null rather than throwing', () => {
    expect(tailFile(path.join(os.tmpdir(), 'huddle-nope', 'node.log'), 10)).toBeNull();
  });
});

describe('parseLines', () => {
  it('defaults to 200', () => {
    expect(parseLines(undefined)).toBe(200);
  });

  it('accepts a whole number in range', () => {
    expect(parseLines('50')).toBe(50);
  });

  it('refuses anything else', () => {
    for (const bad of ['0', '-5', '1.5', 'abc', '100001']) {
      expect(() => parseLines(bad)).toThrow(/Invalid --lines/);
    }
  });
});
