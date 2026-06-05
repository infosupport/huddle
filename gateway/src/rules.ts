import { db } from './db';
import { notifyStateChanged } from './events';

export type RuleStatus = 'allow' | 'deny' | 'requested';

interface RuleRow {
  id: number;
  domain: string;
  status: RuleStatus;
  expires_at: number | null;
  container_id: string | null;
  path_pattern: string | null;
}

// ── Pure match-helpers (geen DB) ─────────────────────────────────────────────
// Bewust los van de DB zodat ze deterministisch testbaar zijn zonder draaiende
// SQLite-binding, analoog aan de helpers in net-gate.ts.

// Matcht een domein-patroon tegen een host. Exacte gelijkheid, of een wildcard
// `*.example.com` die elke subdomein-host matcht (maar NIET kaal `example.com`).
// Bewust strikt: split op punten en vergelijk segment-voor-segment, zodat
// substring-trucs (`evilexample.com`, `a.b.example.com.attacker.com`) falen.
export function matchDomain(pattern: string, host: string): boolean {
  if (!pattern || !host) return false;
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === h) return true;
  if (!p.startsWith('*.')) return false;

  const suffix = p.slice(2).split('.'); // segmenten ná de "*."
  const hostSegs = h.split('.');
  // Een wildcard vereist minstens één subdomein-segment vóór het suffix.
  if (hostSegs.length <= suffix.length) return false;
  const hostSuffix = hostSegs.slice(hostSegs.length - suffix.length);
  return suffix.every((seg, i) => seg === hostSuffix[i]);
}

// Matcht een padpatroon tegen een pad. Een null/leeg patroon is een host-only
// regel en matcht elk pad. `*` aan het eind is een prefix-match
// (`/api/v1/*` matcht `/api/v1/foo`); anders exacte gelijkheid.
export function matchPath(pattern: string | null, path: string | null): boolean {
  if (pattern === null || pattern === '') return true;
  const reqPath = path ?? '';
  if (pattern.endsWith('*')) {
    return reqPath.startsWith(pattern.slice(0, -1));
  }
  return reqPath === pattern;
}

let stmts: ReturnType<typeof prepareStmts> | null = null;

function prepareStmts() {
  return {
    selectPerContainer: db.prepare<[string, string]>(
      `SELECT id, domain, status, expires_at, container_id, path_pattern FROM rules WHERE domain = ? AND container_id = ?`
    ),
    selectGlobal: db.prepare<[string]>(
      `SELECT id, domain, status, expires_at, container_id, path_pattern FROM rules WHERE domain = ? AND container_id IS NULL`
    ),
    selectWildcardPerContainer: db.prepare<[string]>(
      `SELECT id, domain, status, expires_at, container_id, path_pattern FROM rules WHERE domain LIKE '*.%' AND container_id = ?`
    ),
    selectWildcardGlobal: db.prepare(
      `SELECT id, domain, status, expires_at, container_id, path_pattern FROM rules WHERE domain LIKE '*.%' AND container_id IS NULL`
    ),
    touchRule: db.prepare<[number]>(
      `UPDATE rules SET last_seen = unixepoch(), request_count = request_count + 1 WHERE id = ?`
    ),
    insertRequested: db.prepare<[string, string | null]>(
      `INSERT OR IGNORE INTO rules (domain, container_id, status) VALUES (?, ?, 'requested')`
    ),
    resetExpired: db.prepare<[number]>(
      `UPDATE rules SET status='requested', updated_at=unixepoch() WHERE id=?`
    ),
  };
}

function s() {
  if (!stmts) stmts = prepareStmts();
  return stmts;
}

type Candidate = RuleRow & { domain_is_wildcard: boolean };

// Specificiteit van een kandidaat-regel. Hoger = specifieker = wint. Volgorde:
// per-container > globaal; exacte host > wildcard host; mét pad > zonder pad.
function specificity(c: Candidate): number {
  let score = 0;
  if (c.container_id !== null) score += 4;
  if (!c.domain_is_wildcard) score += 2;
  if (c.path_pattern !== null && c.path_pattern !== '') score += 1;
  return score;
}

export function checkRule(
  domain: string,
  containerId: string | null,
  path: string | null = null,
): { status: RuleStatus; ruleId: number | null } {
  const {
    selectPerContainer, selectGlobal, selectWildcardPerContainer, selectWildcardGlobal,
    touchRule, insertRequested, resetExpired,
  } = s();

  // Verzamel alle kandidaat-regels: exacte-host (per-container + globaal) en
  // wildcard-host (per-container + globaal). Filter daarna in TypeScript.
  const candidates: Candidate[] = [];

  const addExact = (rows: RuleRow[]) => {
    for (const r of rows) {
      if (matchPath(r.path_pattern, path)) candidates.push({ ...r, domain_is_wildcard: false });
    }
  };
  const addWildcard = (rows: RuleRow[]) => {
    for (const r of rows) {
      if (matchDomain(r.domain, domain) && matchPath(r.path_pattern, path)) {
        candidates.push({ ...r, domain_is_wildcard: true });
      }
    }
  };

  if (containerId) {
    addExact(selectPerContainer.all(domain, containerId) as RuleRow[]);
    addWildcard(selectWildcardPerContainer.all(containerId) as RuleRow[]);
  }
  addExact(selectGlobal.all(domain) as RuleRow[]);
  addWildcard(selectWildcardGlobal.all() as RuleRow[]);

  if (candidates.length > 0) {
    // Kies de meest specifieke. Bij gelijke specificiteit wint deny van allow
    // (fail-closed).
    candidates.sort((a, b) => {
      const d = specificity(b) - specificity(a);
      if (d !== 0) return d;
      const rank = (st: RuleStatus) => (st === 'deny' ? 0 : st === 'allow' ? 1 : 2);
      return rank(a.status) - rank(b.status);
    });
    const best = candidates[0];

    if (best.status === 'allow' && best.expires_at !== null && best.expires_at < Math.floor(Date.now() / 1000)) {
      resetExpired.run(best.id);
      return { status: 'requested', ruleId: null };
    }
    touchRule.run(best.id);
    return { status: best.status, ruleId: best.id };
  }

  // Geen match → maak een host-only requested-regel aan zodat de operator hem
  // in de UI ziet. (Pad wordt niet vastgelegd: de operator kiest zelf scope.)
  const inserted = insertRequested.run(domain, containerId);
  if (inserted.changes > 0) notifyStateChanged();
  const created = (containerId
    ? (selectPerContainer.all(domain, containerId) as RuleRow[]).find(r => r.path_pattern === null)
    : (selectGlobal.all(domain) as RuleRow[]).find(r => r.path_pattern === null)) as RuleRow | undefined;
  if (created) {
    touchRule.run(created.id);
  }

  return { status: 'requested', ruleId: created?.id ?? null };
}
