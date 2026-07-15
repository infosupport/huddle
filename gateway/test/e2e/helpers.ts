import { spawnSync } from 'node:child_process';

// ── Config (overschrijfbaar via env) ────────────────────────────────────────
export const HUDDLE_URL = process.env.HUDDLE_URL ?? 'http://localhost:3000';
export const E2E_IMAGE  = process.env.HUDDLE_E2E_IMAGE ?? 'ghcr.io/infosupport/base-devimage-vscode';
export const E2E_IDE    = process.env.HUDDLE_E2E_IDE ?? 'vscode';
export const E2E_NAME   = process.env.HUDDLE_E2E_NAME ?? 'devcontainer-e2e-boundary';
export const E2E_ENABLED = process.env.HUDDLE_E2E === '1';

// ── Shell / docker helpers ──────────────────────────────────────────────────
export interface RunResult { status: number; stdout: string; stderr: string; }

export function run(cmd: string, args: string[], timeoutMs = 120_000): RunResult {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs });
  return {
    status: r.status ?? (r.error ? -1 : -1),
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ''),
  };
}

// Voer een shell-commando uit IN de devcontainer (als de remote user).
export function execIn(container: string, shellCmd: string): RunResult {
  return run('docker', ['exec', container, 'sh', '-lc', shellCmd]);
}

// curl in de container; print alleen de HTTP-statuscode (of "000" bij weigering).
export function curlStatusIn(container: string, url: string, extra = ''): string {
  const r = execIn(container, `curl -s -o /dev/null -w '%{http_code}' ${extra} ${url} || true`);
  return r.stdout.trim() || r.stderr.trim();
}

export function dockerAvailable(): boolean {
  return run('docker', ['version', '--format', '{{.Server.Version}}']).status === 0;
}

export function containerRunning(name: string): boolean {
  const r = run('docker', ['inspect', '-f', '{{.State.Running}}', name]);
  return r.status === 0 && r.stdout.trim() === 'true';
}

// ── Huddle management API (admin, vanaf de host op :3000) ────────────────────
// De API eist een operator-token (auth.ts); geef de gateway-onder-test hetzelfde
// token via HUDDLE_OPERATOR_TOKEN, dan authenticeren de helpers daarmee.
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const token = process.env.HUDDLE_OPERATOR_TOKEN?.trim();
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${HUDDLE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    throw new Error(`API ${method} ${path} → ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

// Pre-flight voor de e2e-suite. Gooit met een gerichte melding zodat een
// misconfiguratie niet verdwijnt achter een generiek "niet bereikbaar":
//   - stack down / verkeerde URL  → "niet bereikbaar"
//   - token ontbreekt of fout     → "401 … zet HUDDLE_OPERATOR_TOKEN"
export async function assertHuddleReachable(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${HUDDLE_URL}/api/rules`, {
      headers: process.env.HUDDLE_OPERATOR_TOKEN?.trim()
        ? { authorization: `Bearer ${process.env.HUDDLE_OPERATOR_TOKEN.trim()}` }
        : {},
    });
  } catch (err) {
    throw new Error(`huddle-API niet bereikbaar op ${HUDDLE_URL} — draait de stack? (${(err as Error).message})`);
  }
  if (res.status === 401) {
    throw new Error(
      `huddle-API antwoordt maar weigert auth (401): zet HUDDLE_OPERATOR_TOKEN op het token ` +
      `waarmee de gateway-onder-test gestart is (CI genereert er één in de Start Huddle-stap).`,
    );
  }
  if (!res.ok) {
    throw new Error(`huddle-API pre-flight faalde: GET /api/rules → ${res.status}`);
  }
}

export async function huddleReachable(): Promise<boolean> {
  try { await assertHuddleReachable(); return true; } catch { return false; }
}

export interface Rule { id: number; domain: string; container_id: string | null; status: string; }

export async function getRules(): Promise<Rule[]> {
  return (await api('GET', '/api/rules')) as Rule[];
}

// Verwijder alle rules voor een domein (schoon startpunt voor de firewall-test).
export async function clearRulesForDomain(domain: string): Promise<void> {
  const rules = await getRules();
  for (const r of rules.filter(r => r.domain === domain)) {
    try { await api('DELETE', `/api/rules/${r.id}`); } catch { /* race: al weg */ }
  }
}

// Zet een domein voor deze container (of globaal) op 'allow'.
export async function allowDomain(domain: string, container: string): Promise<void> {
  const rules = await getRules();
  const match = rules.find(r => r.domain === domain && r.container_id === container)
            ?? rules.find(r => r.domain === domain);
  if (match) {
    await api('PUT', `/api/rules/${match.id}`, { status: 'allow' });
  } else {
    await api('POST', '/api/rules', { domain, container_id: container, status: 'allow' });
  }
}

export async function setGrant(container: string, minutes: number): Promise<void> {
  await api('PUT', `/api/authz/grants/${encodeURIComponent(container)}`, { minutes });
}

export async function revokeGrant(container: string): Promise<void> {
  try { await api('DELETE', `/api/authz/grants/${encodeURIComponent(container)}`); } catch { /* none */ }
}

// Zet een fijnmazige actie-toggle (bv. 'container.list') aan of uit.
export async function setActionPolicy(container: string, action: string, enabled: boolean): Promise<void> {
  await api(
    'PUT',
    `/api/authz/docker-actions/${encodeURIComponent(container)}/${encodeURIComponent(action)}`,
    { enabled },
  );
}

// ── Container-lifecycle via de huddle API ────────────────────────────────────
export async function spawnDevcontainer(): Promise<void> {
  await api('POST', '/api/docker/start', {
    imageName: E2E_IMAGE,
    containerName: E2E_NAME,
    ideName: E2E_IDE,
    empty: true,
  });
  // Wacht tot de container draait én de post-start config-exec klaar is
  // (sudo/iptables/curlrc draaien detached). We pollen op een teken van leven.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (containerRunning(E2E_NAME) && execIn(E2E_NAME, 'command -v curl >/dev/null && command -v docker >/dev/null').status === 0) {
      // Geef de detached config-exec nog even om iptables/proxy te zetten.
      await sleep(4000);
      return;
    }
    await sleep(2000);
  }
  throw new Error(`devcontainer ${E2E_NAME} kwam niet (volledig) up binnen de timeout`);
}

export async function removeDevcontainer(): Promise<void> {
  try { await api('DELETE', `/api/docker/containers/${encodeURIComponent(E2E_NAME)}`); }
  catch { run('docker', ['rm', '-f', E2E_NAME]); } // fallback
}

export function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}
