import { db } from './db';

export type RuleStatus = 'allow' | 'deny' | 'requested';

interface RuleRow {
  id: number;
  status: RuleStatus;
}

let stmts: ReturnType<typeof prepareStmts> | null = null;

function prepareStmts() {
  return {
    selectPerContainer: db.prepare<[string, string]>(
      `SELECT id, status FROM rules WHERE domain = ? AND container_id = ? LIMIT 1`
    ),
    selectGlobal: db.prepare<[string]>(
      `SELECT id, status FROM rules WHERE domain = ? AND container_id IS NULL LIMIT 1`
    ),
    touchRule: db.prepare<[number]>(
      `UPDATE rules SET last_seen = unixepoch(), request_count = request_count + 1 WHERE id = ?`
    ),
    insertRequested: db.prepare<[string, string | null]>(
      `INSERT OR IGNORE INTO rules (domain, container_id, status) VALUES (?, ?, 'requested')`
    ),
  };
}

function s() {
  if (!stmts) stmts = prepareStmts();
  return stmts;
}

export function checkRule(domain: string, containerId: string | null): RuleStatus {
  const { selectPerContainer, selectGlobal, touchRule, insertRequested } = s();

  if (containerId) {
    const perContainer = selectPerContainer.get(domain, containerId) as RuleRow | undefined;
    if (perContainer) {
      touchRule.run(perContainer.id);
      return perContainer.status;
    }
  }

  const global = selectGlobal.get(domain) as RuleRow | undefined;
  if (global) {
    touchRule.run(global.id);
    return global.status;
  }

  insertRequested.run(domain, containerId);
  const created = (containerId
    ? selectPerContainer.get(domain, containerId)
    : selectGlobal.get(domain)) as RuleRow | undefined;
  if (created) {
    touchRule.run(created.id);
  }

  return 'requested';
}
