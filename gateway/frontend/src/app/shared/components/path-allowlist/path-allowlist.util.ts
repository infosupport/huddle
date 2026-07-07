import { Rule } from '../../../core/models/rule.model';

// A single path-allowlist domain: the host-only marker rule (path_mode=1) plus the
// path rules that fall under it, split by status.
export interface PathDomainVm {
  marker: Rule;
  domain: string;
  scope: string; // container_id or '(global)'
  allowed: Rule[];
  denied: Rule[];
  requested: Rule[];
}

// Identity of a (domain, container): determines whether a rule belongs to the same
// path-allowlist domain as the marker.
export function ruleKey(r: Rule): string {
  return `${r.container_id ?? ''}|${r.domain}`;
}

// Keys of all host-only marker rules (path_mode=1) in this set.
export function pathModeKeySet(rules: Rule[]): Set<string> {
  return new Set(
    rules.filter(r => r.path_mode === 1 && !r.path_pattern).map(ruleKey),
  );
}

// Rules that do NOT belong to a path-allowlist domain — for the regular
// allow/deny/requested lists, so that marker + path rules don't appear there
// duplicated (and ugly).
export function excludePathModeRules(rules: Rule[]): Rule[] {
  const keys = pathModeKeySet(rules);
  return rules.filter(r => !keys.has(ruleKey(r)));
}

// Builds the path-allowlist domain view models from a collection of rules.
export function buildPathDomains(rules: Rule[]): PathDomainVm[] {
  const markers = rules.filter(r => r.path_mode === 1 && !r.path_pattern);
  const byPattern = (a: Rule, b: Rule) => (a.path_pattern ?? '').localeCompare(b.path_pattern ?? '');
  return markers
    .map(m => {
      const paths = rules.filter(r => ruleKey(r) === ruleKey(m) && !!r.path_pattern);
      return {
        marker: m,
        domain: m.domain,
        scope: m.container_id ?? '(global)',
        allowed: paths.filter(r => r.status === 'allow').sort(byPattern),
        denied: paths.filter(r => r.status === 'deny').sort(byPattern),
        requested: paths.filter(r => r.status === 'requested').sort((a, b) => b.last_seen - a.last_seen),
      };
    })
    .sort((a, b) => a.domain.localeCompare(b.domain));
}
