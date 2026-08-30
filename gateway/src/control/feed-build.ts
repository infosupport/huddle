// Building the feeds, on Huddle Node.
//
// Split from ./feed (which is types only) because this half reads SQLite and
// the Docker socket, and the gateway must be able to name a PolicyFeed without
// dragging either into its process.
//
// A rule set is small — hundreds of rows — so serializing and hashing the whole
// thing per poll is not worth optimizing; the gateway asks with If-None-Match
// and usually gets a 304 back.

import { db } from '../db';
import { containerSnapshot } from '../docker';
import type { RuleRow } from '../rule-match';
import type { ContainerFeed, PolicyFeed } from './feed';
import { feedVersion } from './http';

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

  const feed: PolicyFeed = { version: '', rules, airlocked };
  feed.version = feedVersion(JSON.stringify({ rules, airlocked }));
  return feed;
}

export async function buildContainerFeed(): Promise<ContainerFeed> {
  const { byIp: map, devcontainers } = await containerSnapshot();
  const byIp: Record<string, string> = {};
  for (const ip of [...map.keys()].sort()) byIp[ip] = map.get(ip)!;
  // Only the hash leaves this process. Node mints and spends the secret (it
  // writes the sandbox' upstream-proxy URL); the gateway is handed just enough
  // to recognise one. See ./feed and docs/ADR-sbx-identity.md §5.
  const sandboxAuth: Record<string, string> = {};
  const identities = db
    .prepare(`SELECT name, secret_hash FROM sandbox_identity ORDER BY name`)
    .all() as { name: string; secret_hash: string }[];
  for (const row of identities) sandboxAuth[row.secret_hash] = row.name;
  // sandboxAuth is part of the version: a sandbox created or removed has to
  // reach the gateway on the next poll, or the box is denied by a stale feed.
  const version = feedVersion(JSON.stringify({ byIp, devcontainers, sandboxAuth }));
  return { version, byIp, sandboxAuth, devcontainers };
}
