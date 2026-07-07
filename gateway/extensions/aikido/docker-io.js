'use strict';

const net               = require('net');
const crypto            = require('crypto');
const fs                = require('fs');
const { execFile }      = require('child_process');
const { promisify }     = require('util');
const execFileAsync     = promisify(execFile);

// ── Docker-communicatie ──────────────────────────────────────────────────────

function dockerRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = [
      `${method} ${urlPath} HTTP/1.1`,
      'Host: localhost',
      'Content-Type: application/json',
      `Content-Length: ${payload ? Buffer.byteLength(payload) : 0}`,
      'Connection: close',
    ].join('\r\n') + '\r\n\r\n' + (payload ?? '');
    const sock = net.connect('/var/run/docker.sock');
    let raw = '';
    sock.on('data', d => { raw += d.toString(); });
    sock.on('end', () => {
      const [head, ...rest] = raw.split('\r\n\r\n');
      const status = parseInt((head.split('\r\n')[0] ?? '').split(' ')[1] ?? '0', 10);
      const bodyStr = rest.join('\r\n\r\n').replace(/^[0-9a-f]+\r\n/gm, '').replace(/\r\n/g, '');
      try {
        const parsed = bodyStr ? JSON.parse(bodyStr) : {};
        if (status >= 400) reject(new Error(`Docker ${method} ${urlPath} → ${status}: ${bodyStr}`));
        else resolve(parsed);
      } catch { resolve({}); }
    });
    sock.on('error', reject);
    sock.write(headers);
  });
}

// Injecteer bestanden in een container via docker cp (transparant, geen base64-obfuscatie).
async function writeScript(info, files, claudeJson, workspace) {
  const aikidoDir = `${workspace}/aikido`;

  // Maak doelmappen aan
  const mkdirExec = await dockerRequest('POST', `/containers/${info.Id}/exec`, {
    User: 'root', Cmd: ['sh', '-c', `mkdir -p ${aikidoDir} /usr/local/lib /usr/local/bin`],
    AttachStdout: false, AttachStderr: false,
  });
  await dockerRequest('POST', `/exec/${mkdirExec.Id}/start`, { Detach: true });

  // Kopieer elk bestand via een tijdelijk hostbestand + docker cp (async, non-blocking)
  const tmpFiles = [];
  try {
    for (const [containerPath, content] of Object.entries(files)) {
      const tmpPath = `/tmp/huddle-inject-${crypto.randomBytes(8).toString('hex')}.tmp`;
      tmpFiles.push(tmpPath);
      await fs.promises.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
      await execFileAsync('docker', ['cp', tmpPath, `${info.Id}:${containerPath}`]);
    }
  } finally {
    for (const tmpPath of tmpFiles) {
      try { await fs.promises.unlink(tmpPath); } catch (err) { console.error(`Failed to cleanup tmp file ${tmpPath}:`, err); }
    }
  }

  // Post-copy: chmod, chown, merge .claude.json — single quotes om JSON-quotes te escapen
  const mergeScript = `node -e 'const fs=require("fs"),p="/home/vscode/.claude.json";let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"));}catch{}const n=${JSON.stringify(JSON.parse(claudeJson))};s.mcpServers=Object.assign(s.mcpServers||{},n.mcpServers);fs.writeFileSync(p,JSON.stringify(s,null,2));try{fs.chownSync(p,1000,1000);}catch{}'`;
  const postCopyScript = `chmod +x /usr/local/bin/aikido-fix && chown -R vscode:vscode ${workspace} && ${mergeScript}`;

  const exec = await dockerRequest('POST', `/containers/${info.Id}/exec`, {
    User: 'root', Cmd: ['sh', '-c', postCopyScript], AttachStdout: false, AttachStderr: false,
  });
  await dockerRequest('POST', `/exec/${exec.Id}/start`, { Detach: true });

  // Gitignore update als aparte exec
  const gitignoreScript = `grep -qxF /aikido ${workspace}/.gitignore 2>/dev/null || printf '\\n/aikido\\n' >> ${workspace}/.gitignore`;
  const giExec = await dockerRequest('POST', `/containers/${info.Id}/exec`, {
    User: 'root', Cmd: ['sh', '-c', gitignoreScript], AttachStdout: false, AttachStderr: false,
  });
  await dockerRequest('POST', `/exec/${giExec.Id}/start`, { Detach: true });
}

module.exports = { dockerRequest, writeScript };
