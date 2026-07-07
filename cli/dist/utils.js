"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cyan = exports.yellow = exports.green = exports.red = exports.dim = exports.bold = void 0;
exports.formatTime = formatTime;
exports.promptKey = promptKey;
exports.printTable = printTable;
const readline_1 = require("readline");
const ESC = '\x1b[';
const isTTY = process.stdout.isTTY && process.env.NO_COLOR !== '1';
const fmt = (code, text) => (isTTY ? `${ESC}${code}m${text}${ESC}0m` : text);
const bold = (t) => fmt(1, t);
exports.bold = bold;
const dim = (t) => fmt(2, t);
exports.dim = dim;
const red = (t) => fmt(31, t);
exports.red = red;
const green = (t) => fmt(32, t);
exports.green = green;
const yellow = (t) => fmt(33, t);
exports.yellow = yellow;
const cyan = (t) => fmt(36, t);
exports.cyan = cyan;
function formatTime(unixSec) {
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
    if (diff < 60)
        return `${diff}s geleden`;
    if (diff < 3600)
        return `${Math.floor(diff / 60)}m geleden`;
    if (diff < 86400)
        return `${Math.floor(diff / 3600)}u geleden`;
    return `${Math.floor(diff / 86400)}d geleden`;
}
function promptKey(prompt) {
    return new Promise((resolve) => {
        process.stdout.write(prompt);
        const stdin = process.stdin;
        const hasRaw = stdin.isTTY && typeof stdin.setRawMode === 'function';
        if (!hasRaw) {
            const rl = (0, readline_1.createInterface)({ input: process.stdin });
            rl.once('line', (line) => {
                rl.close();
                resolve(line.trim().charAt(0));
            });
            return;
        }
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        stdin.once('data', (data) => {
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
function printTable(headers, rows) {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
    const line = (cells, colorFn) => cells.map((c, i) => (colorFn ? colorFn(c.padEnd(widths[i])) : c.padEnd(widths[i]))).join('  ');
    console.log((0, exports.bold)(line(headers)));
    console.log((0, exports.dim)('-'.repeat(widths.reduce((a, w) => a + w + 2, -2))));
    rows.forEach((row) => console.log(line(row)));
}
