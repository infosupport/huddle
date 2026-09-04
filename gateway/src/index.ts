// Which half of Huddle this process is.
//
// Huddle runs as two processes (docs/ADR-huddle-node-split.md): Huddle Node,
// the control plane on the host, and huddle-gateway, the network enforcement
// point in Docker. This file picks one and does nothing else.
//
// The imports are dynamic on purpose. db.ts opens the database at import time
// and docker.ts a Docker client, so a static import graph would do both in the
// gateway even though it never calls them — in the one process a devcontainer
// can reach. Deciding first and importing after is what keeps them out.

import { runtimeEnv } from './runtime-env';

// ECONNRESET / EPIPE are normal client-disconnect events on a TCP server.
// Without this handler Node.js crashes the process on unhandled 'error' events
// from sockets that lose their connection unexpectedly.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
  console.error('[fatal] uncaught exception:', err);
  process.exit(1);
});

/**
 * Fails with a sentence instead of a stack trace when node:sqlite is missing.
 *
 * Huddle Node stores everything in node:sqlite (src/sqlite.ts). It landed in
 * Node 22.5 behind --experimental-sqlite and became unflagged in 23.4, so an
 * older Node reaches the store through three dynamic imports and then throws
 * ERR_UNKNOWN_BUILTIN_MODULE from deep inside the CommonJS loader — pointing at
 * dist/sqlite.js, which says nothing about the Node version being the cause.
 *
 * Loading the module IS the test. Version arithmetic would have to guess about
 * both the 22.5 flag and the 23.4 change, and node:sqlite is absent from
 * module.builtinModules even where it works, because that list omits
 * experimental modules.
 *
 * The gateway half never calls this: it has no database (gateway/Dockerfile).
 */
async function requireNodeSqlite(): Promise<void> {
  try {
    await import('node:sqlite');
  } catch {
    console.error(
      `[fatal] Huddle Node needs node:sqlite, which this Node does not have.\n` +
        `        running: Node ${process.versions.node} at ${process.execPath}\n` +
        `        needed:  Node 24 (or 22.5+ started with --experimental-sqlite)\n` +
        `        The Docker image and CI both run Node 24; a host install is the\n` +
        `        usual place to be behind.`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log(`[boot] role=${runtimeEnv.role}`);
  if (runtimeEnv.runsGateway) {
    const { bootGateway } = await import('./boot-gateway');
    bootGateway();
  } else {
    await requireNodeSqlite();
    const { bootNode } = await import('./boot-node');
    bootNode();
  }
}

main().catch(err => {
  console.error('[fatal] failed to start:', err);
  process.exit(1);
});
