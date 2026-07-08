import { createInterface } from 'readline';

const ESC = '\x1b[';
const isTTY = process.stdout.isTTY && process.env.NO_COLOR !== '1';

const fmt = (code: number, text: string) => (isTTY ? `${ESC}${code}m${text}${ESC}0m` : text);

export const bold = (t: string) => fmt(1, t);
export const dim = (t: string) => fmt(2, t);
export const red = (t: string) => fmt(31, t);
export const green = (t: string) => fmt(32, t);
export const yellow = (t: string) => fmt(33, t);
export const cyan = (t: string) => fmt(36, t);

export function formatTime(unixSec: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function promptKey(prompt: string): Promise<string> {
  return new Promise<string>((resolve) => {
    process.stdout.write(prompt);

    const stdin = process.stdin as NodeJS.ReadStream;
    const hasRaw = stdin.isTTY && typeof stdin.setRawMode === 'function';

    if (!hasRaw) {
      const rl = createInterface({ input: process.stdin });
      rl.once('line', (line: string) => {
        rl.close();
        resolve(line.trim().charAt(0));
      });
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    stdin.once('data', (data: Buffer | string) => {
      stdin.setRawMode(false);
      stdin.pause();

      const key = data.toString();
      if (key === '\u0003') {
        process.stdout.write('\n');
        process.exit(0);
      }
      if (key === '\u001b') {
        process.stdout.write('\n');
        resolve('');
        return;
      }
      process.stdout.write(`${key}\n`);
      resolve(key);
    });
  });
}

export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[], colorFn?: (s: string) => string) =>
    cells.map((c, i) => (colorFn ? colorFn(c.padEnd(widths[i])) : c.padEnd(widths[i]))).join('  ');

  console.log(bold(line(headers)));
  console.log(dim('-'.repeat(widths.reduce((a, w) => a + w + 2, -2))));
  rows.forEach((row) => console.log(line(row)));
}
