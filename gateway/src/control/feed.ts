// What Huddle Node publishes to the gateway.
//
// The gateway needs three things from the control plane to filter traffic:
// the firewall policy, the set of sandboxes a fleet decision merges across, and
// the IP→container mapping that attributes a connection to a devcontainer.
// Today it gets all three by reading SQLite and the Docker socket itself. After
// the split it has neither, so Node serves them here.
//
// These are FEEDS, not queries. The gateway holds the whole thing in memory and
// decides locally (see ./decide) — asking Node per request would put Node in the
// hot path and stop all egress the moment it is down. Both feeds are therefore
// versioned so the gateway can poll cheaply and only pay for a real change.
//
// Versioning is a content hash (see ./http). A rule set is small — hundreds of
// rows — so hashing the whole thing per poll is not worth optimizing.

import { db } from '../db';
import { containerIpMap } from '../docker';
import { knownSandboxNames } from '../sandbox/registry';
import type { RuleRow } from '../rule-match';
import { feedVersion } from './http';

/** The firewall policy, in the form `decide()` needs it. */
export interface PolicyFeed {
  version: string;
  rules: RuleRow[];
  /** Containers with no global-rule fallback; their snapshots carry no globals. */
  airlocked: string[];
  /** The sandboxes a fleet decision merges rules across. */
  sandboxes: string[];
}

/** Which devcontainer a source address belongs to. */
export interface ContainerFeed {
  version: string;
  byIp: Record<string, string>;
}

export function buildPolicyFeed(): PolicyFeed {
  // ORDER BY id so the hash is a function of the content and not of whatever
  // order SQLite happened to return rows in.
  const rules = db
    .prepare(
      `SELECT id, domain, status, expires_at, container_id, path_pattern, path_mode
       FROM rules ORDER BY id`
    )
    .all() as RuleRow[];
  const airlocked = (db
    .prepare(`SELECT name FROM containers WHERE airlocked = 1 ORDER BY name`)
    .all() as { name: string }[]).map((r) => r.name);
  const sandboxes = [...knownSandboxNames()].sort();

  const feed: PolicyFeed = { version: '', rules, airlocked, sandboxes };
  feed.version = feedVersion(JSON.stringify({ rules, airlocked, sandboxes }));
  return feed;
}

export async function buildContainerFeed(): Promise<ContainerFeed> {
  const map = await containerIpMap();
  const byIp: Record<string, string> = {};
  for (const ip of [...map.keys()].sort()) byIp[ip] = map.get(ip)!;
  return { version: feedVersion(JSON.stringify(byIp)), byIp };
}
