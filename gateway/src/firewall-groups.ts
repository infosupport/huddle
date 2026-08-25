// Firewall groups + team-managed rules folder (#69) — public surface.
//
// A *group* is a named, reusable bundle of firewall rules for a product/service
// (OpenAI, GitHub, Node.js, …). Groups can be created in the portal, imported
// and exported as a JSON envelope, applied to a scope (global or one container),
// and loaded automatically from a team-managed folder that teams keep in Git.
//
// The implementation is split by responsibility — import from these directly when
// you only need one of them:
//   ./firewall-group-envelope  envelope shape + fail-closed validation (pure)
//   ./firewall-group-store     database reads/writes for groups and their rules
//   ./firewall-rules-folder    the team-managed folder on disk (reload + sync)

export {
  GROUP_ENVELOPE_KIND,
  GROUP_ENVELOPE_VERSION,
  serializeGroupEnvelope,
  validateGroupEnvelope,
  validateGroupRule,
  type GroupEnvelope,
  type ShareableGroupRule,
} from './firewall-group-envelope';

export {
  applyGroup,
  clearFolderManagedRules,
  exportGroup,
  importGroupEnvelope,
  retagGroupAsFolderManaged,
  type ImportGroupSummary,
} from './firewall-group-store';

export {
  firewallRulesMount,
  reloadFirewallRulesFolder,
  syncGroupsToFolder,
  type FolderReloadSummary,
  type FolderSyncSummary,
} from './firewall-rules-folder';
