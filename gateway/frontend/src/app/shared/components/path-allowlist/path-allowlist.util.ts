import { Rule } from '../../../core/models/rule.model';

// Eén pad-allowlist domein: de host-only marker-regel (path_mode=1) plus de
// padregels die eronder vallen, gesplitst op status.
export interface PathDomainVm {
  marker: Rule;
  domain: string;
  scope: string; // container_id of '(global)'
  allowed: Rule[];
  denied: Rule[];
  requested: Rule[];
}

// Identiteit van een (domein, container): bepaalt of een regel bij hetzelfde
// pad-allowlist domein hoort als de marker.
export function ruleKey(r: Rule): string {
  return `${r.container_id ?? ''}|${r.domain}`;
}

// Keys van alle host-only marker-regels (path_mode=1) in deze set.
export function pathModeKeySet(rules: Rule[]): Set<string> {
  return new Set(
    rules.filter(r => r.path_mode === 1 && !r.path_pattern).map(ruleKey),
  );
}

// Regels die NIET bij een pad-allowlist domein horen — voor de gewone
// allow/deny/requested-lijsten, zodat marker + padregels daar niet dubbel
// (en lelijk) verschijnen.
export function excludePathModeRules(rules: Rule[]): Rule[] {
  const keys = pathModeKeySet(rules);
  return rules.filter(r => !keys.has(ruleKey(r)));
}

// Bouwt de pad-allowlist domein-viewmodellen uit een verzameling regels.
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
