import { Rule } from './rule.model';

// A firewall group (#69): a named, reusable bundle of firewall rules for a
// product/service. `source` is 'manual' (created in the UI) or 'startup-folder'
// (loaded from the team-managed rules folder).
export interface FirewallGroup {
  id: number;
  name: string;
  description: string;
  shared: number;
  source: string;
  created_at: number;
  updated_at: number;
  rule_count: number;
}

export interface GroupDetail {
  group: FirewallGroup;
  rules: Rule[];
}

export interface ImportGroupResult {
  group: FirewallGroup;
  imported: number;
  updated: number;
  skipped: number;
}
