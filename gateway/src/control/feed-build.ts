// Building the feeds, on Huddle Node.
//
// Split from ./feed (which is types only) because this half reads SQLite and
// the Docker socket, and the gateway must be able to name a PolicyFeed without
// dragging either into its process.
//
// A rule set is small — hundreds of rows — so serializing and hashing the whole
// thing per poll is not worth optimizing; the gateway asks with If-None-Match
// and usually gets a 304 back.

import { db, listRegisteredSocketNames, pruneDeadSocketRegistrations, socketRegistrationRevisions } from '../db';
import { containerSnapshot, currentNetworkGeneration } from '../docker';
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
  const { byIp: map, devcontainers: running } = await containerSnapshot();
  const byIp: Record<string, string> = {};
  for (const ip of [...map.keys()].sort()) byIp[ip] = map.get(ip)!;
  // Union with the names `huddle migrate --docker-socket` registered
  // (blocker 15): those containers are not Huddle's own and carry none of the
  // IDE labels containerSnapshot() filters on, and — unlike a devcontainer —
  // are meant to get a socket BEFORE they ever run, so the socket exists by
  // the time compose starts them and their bind mount sees a live file
  // instead of an empty directory. `running` alone would never include them.
  // A row that was ready (served at least once) and has since dropped out of
  // Docker's live list is a container that existed and is now gone — removed
  // directly against the engine, since Huddle has no devcontainer "delete"
  // route of its own to have unregistered it from. Prune before reading the
  // table below so this same poll already reflects it, instead of leaking a
  // relay listener/directory for a container nothing will ever restart. A row
  // that isn't ready yet is left alone regardless of `running` — that is the
  // expected, temporary state for a name `huddle migrate --docker-socket` (or
  // createAndStartContainer, briefly) registered ahead of its container
  // starting; see pruneDeadSocketRegistrations' doc in db.ts.
  pruneDeadSocketRegistrations(running);
  const socketRegistrations = listRegisteredSocketNames();
  const socketRevisions = socketRegistrationRevisions();
  const devcontainers = [...new Set([...running, ...socketRegistrations])].sort();
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
  //
  // networkGeneration is part of it for the same reason, but for a change
  // `byIp`/`devcontainers` cannot see on their own — see ContainerFeed's doc.
  const networkGeneration = currentNetworkGeneration();
  const version = feedVersion(JSON.stringify({ byIp, devcontainers, socketRegistrations, socketRevisions, sandboxAuth, networkGeneration }));
  return { version, byIp, sandboxAuth, devcontainers, socketRegistrations, socketRegistrationRevisions: socketRevisions, networkGeneration };
}
