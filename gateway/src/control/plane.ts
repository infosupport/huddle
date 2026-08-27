// The gateway's view of the control plane.
//
// Everything the filtering proxy needs from outside itself passes through here:
// firewall policy, the IP→container mapping, and the audit sink. The proxy has
// exactly ONE seam to the control plane instead of four direct imports
// (`rules`, `db`, `docker`, `sandbox/registry`), and that seam is now genuinely
// remote: Huddle Node runs on the host and owns the database, the Docker socket
// and the sandbox registry, while the gateway keeps only the proxies
// (docs/ADR-huddle-node-split.md).
//
// There is one binding, ./client, and no in-process fallback. A second
// implementation reading SQLite directly would be a second definition of the
// firewall — and the one that drifts is the one nobody runs in production.
//
// HOW THE WRITES GET DONE
//   `checkRule` is not a read. On a miss the answer implies a `requested` rule
//   so the operator sees the blocked host in the portal, refreshed last-seen
//   metadata, expired allows reset, and an audit row. The gateway cannot perform
//   any of that: it has no database. So the decision is split in two —
//   ./decide returns the answer plus an explicit list of effects, the answer is
//   applied here and now, and the effects are batched to Node (./client), which
//   writes them down (./apply). The one thing that cannot be deferred is the id
//   of a rule that does not exist yet, which is why an audit entry may carry a
//   `ruleRef` pointing at the effect that mints it.

import type { AuditEntry, AuditResponse } from '../db-types';
import type { RuleStatus } from '../rule-match';

export interface RuleDecision {
  status: RuleStatus;
  ruleId: number | null;
  /**
   * Set when this decision filed a NEW rule, whose id only exists once Node has
   * applied the effect. Pass it to `logAudit` as `entry.ruleRef` to have the
   * audit row point at that rule anyway.
   */
  ruleRef?: number | null;
}

export interface ControlPlane {
  /** Evaluate a devcontainer request against the firewall policy. */
  checkRule(domain: string, containerId: string | null, path: string | null): RuleDecision;
  /** Evaluate a sandbox-fleet request, which is never attributable to one box. */
  checkFleetRule(domain: string, sandboxNames: Set<string>, path: string | null): RuleDecision;
  /** Whether this host is in path-allowlist mode. */
  isPathMode(domain: string, containerId: string | null): boolean;
  /** The sandboxes the fleet check merges rules across. */
  knownSandboxNames(): Set<string>;
  /** Map a connection's source address to the container that owns it. */
  resolveContainerByIp(ip: string): Promise<string | null>;
  /** Record a request. The returned ref correlates the later response update. */
  logAudit(entry: AuditEntry): number | null;
  /** Fill in the response fields on a previously logged in-flight request. */
  updateAuditResponse(ref: number, response: AuditResponse): void;
  /**
   * Hand a raw sudo log line to Node, which parses and files it.
   *
   * Devcontainers post these to Huddle themselves (docker.ts installs the
   * forwarder), and the endpoint they post to is answered by the proxy — so this
   * relay is what keeps that contract working now that the gateway has no API
   * and no database. `containerId` is the gateway's own IP→container lookup,
   * never anything the caller sent.
   */
  reportSudoAudit(containerId: string, entry: string): void;
}

// What the proxy sees before anything is bound. Not a stub for tests: it is the
// answer during the seconds between the process starting and the control client
// connecting, and the only safe answer then is no.
const unboundControlPlane: ControlPlane = {
  checkRule: () => ({ status: 'deny', ruleId: null }),
  checkFleetRule: () => ({ status: 'deny', ruleId: null }),
  isPathMode: () => false,
  knownSandboxNames: () => new Set(),
  resolveContainerByIp: async () => null,
  logAudit: () => null,
  updateAuditResponse: () => {},
  reportSudoAudit: () => {},
};

let active: ControlPlane = unboundControlPlane;

/** Bind the plane. Done once at boot by ./client; and by tests. */
export function setControlPlane(plane: ControlPlane): void {
  active = plane;
}

export function resetControlPlane(): void {
  active = unboundControlPlane;
}

// Read through `active` on every call rather than destructuring it once, so a
// swap takes effect immediately and cannot be captured by an early import.
export const controlPlane: ControlPlane = {
  checkRule: (domain, containerId, path) => active.checkRule(domain, containerId, path),
  checkFleetRule: (domain, sandboxNames, path) => active.checkFleetRule(domain, sandboxNames, path),
  isPathMode: (domain, containerId) => active.isPathMode(domain, containerId),
  knownSandboxNames: () => active.knownSandboxNames(),
  resolveContainerByIp: (ip) => active.resolveContainerByIp(ip),
  logAudit: (entry) => active.logAudit(entry),
  updateAuditResponse: (ref, response) => active.updateAuditResponse(ref, response),
  reportSudoAudit: (containerId, entry) => active.reportSudoAudit(containerId, entry),
};
