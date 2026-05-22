import { db } from './db';
import { notifyStateChanged } from './events';

export type RuleStatus = 'allow' | 'deny' | 'requested';

interface RuleRow {
  id: number;
  status: RuleStatus;
  expires_at: number | null;
}

let stmts: ReturnType<typeof prepareStmts> | null = null;

function prepareStmts() {
  return {
    selectPerContainer: db.prepare<[string, string]>(
      `SELECT id, status, expires_at FROM rules WHERE domain = ? AND container_id = ? LIMIT 1`
    ),
    selectGlobal: db.prepare<[string]>(
      `SELECT id, status, expires_at FROM rules WHERE domain = ? AND container_id IS NULL LIMIT 1`
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

export function checkRule(
  domain: string,
  containerId: string | null,
): { status: RuleStatus; ruleId: number | null } {
  const { selectPerContainer, selectGlobal, touchRule, insertRequested, resetExpired } = s();

  if (containerId) {
    const perContainer = selectPerContainer.get(domain, containerId) as RuleRow | undefined;
    if (perContainer) {
      if (perContainer.status === 'allow' && perContainer.expires_at !== null && perContainer.expires_at < Math.floor(Date.now() / 1000)) {
        resetExpired.run(perContainer.id);
        return { status: 'requested', ruleId: null };
      }
      touchRule.run(perContainer.id);
      return { status: perContainer.status, ruleId: perContainer.id };
    }
  }

  const global = selectGlobal.get(domain) as RuleRow | undefined;
  if (global) {
    if (global.status === 'allow' && global.expires_at !== null && global.expires_at < Math.floor(Date.now() / 1000)) {
      resetExpired.run(global.id);
      return { status: 'requested', ruleId: null };
    }
    touchRule.run(global.id);
    return { status: global.status, ruleId: global.id };
  }

  const inserted = insertRequested.run(domain, containerId);
  if (inserted.changes > 0) notifyStateChanged();
  const created = (containerId
    ? selectPerContainer.get(domain, containerId)
    : selectGlobal.get(domain)) as RuleRow | undefined;
  if (created) {
    touchRule.run(created.id);
  }

  return { status: 'requested', ruleId: created?.id ?? null };
}
