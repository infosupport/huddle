// The gateway's view of the control plane.
//
// Everything the filtering proxy needs from outside itself passes through here:
// firewall policy, the IP→container mapping, and the audit sink. Today every
// one of them is satisfied in-process by SQLite and the Docker socket, and this
// module is a thin pass-through — binding it changes no behaviour.
//
// It exists so that the proxy has exactly ONE seam to the control plane instead
// of four direct imports (`rules`, `db`, `docker`, `sandbox/registry`). When
// Huddle Node moves to the host (docs/ADR-huddle-node-split.md) the gateway
// keeps only the proxy, and this is the interface a remote binding has to
// satisfy — the surface to replace is visible in one file rather than spread
// over 40 call sites.
//
// WHAT A REMOTE BINDING STILL HAS TO SOLVE
//   `checkRule` is not a read. On a miss it INSERTS a `requested` rule so the
//   operator sees the blocked host in the portal, refreshes last-seen metadata,
//   expires timed-out allows, fires a UI event, and then re-reads the row to
//   return the database-assigned `ruleId`. A gateway holding only a pushed
//   policy snapshot cannot mint that id — it is Node's to assign. Splitting the
//   evaluation into a pure decision plus a stream of effects (the decision
//   applies locally, the effects reach Node asynchronously and the audit row is
//   correlated there) is the next step, deliberately not taken in this commit.

import { checkRule, checkFleetRule, isPathMode } from '../rules';
import { knownSandboxNames } from '../sandbox/registry';
import { resolveContainerByIp } from '../docker';
import { logAudit, updateAuditResponse, type AuditEntry, type AuditResponse } from '../db';
import type { RuleStatus } from '../rules';

export interface RuleDecision {
  status: RuleStatus;
  ruleId: number | null;
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
  /** Record a request. The returned id correlates the later response update. */
  logAudit(entry: AuditEntry): number | null;
  /** Fill in the response fields on a previously logged in-flight request. */
  updateAuditResponse(id: number, response: AuditResponse): void;
}

// The combined-process binding: straight through to the modules the proxy used
// to import directly. This is the behaviour of every Huddle release so far.
export const inProcessControlPlane: ControlPlane = {
  checkRule: (domain, containerId, path) => checkRule(domain, containerId, path),
  checkFleetRule: (domain, sandboxNames, path) => checkFleetRule(domain, sandboxNames, path),
  isPathMode: (domain, containerId) => isPathMode(domain, containerId),
  knownSandboxNames: () => knownSandboxNames(),
  resolveContainerByIp: (ip) => resolveContainerByIp(ip),
  logAudit: (entry) => logAudit(entry),
  updateAuditResponse: (id, response) => updateAuditResponse(id, response),
};

let active: ControlPlane = inProcessControlPlane;

/** Swap the binding. Used by tests today; by the host binding later. */
export function setControlPlane(plane: ControlPlane): void {
  active = plane;
}

export function resetControlPlane(): void {
  active = inProcessControlPlane;
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
  updateAuditResponse: (id, response) => active.updateAuditResponse(id, response),
};
