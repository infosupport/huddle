// Which half of Huddle this process is.
//
// Huddle runs as two processes (docs/ADR-huddle-node-split.md): Huddle Node,
// the control plane on the host, and huddle-gateway, the network enforcement
// point in Docker. This file picks one and does nothing else.
//
// The imports are dynamic on purpose. A static import graph would load
// better-sqlite3 and dockerode into the gateway even though it never calls
// them — a native database binding and a Docker client in the one process a
// devcontainer can reach. Deciding first and importing after is what keeps them
// out.

import { runtimeEnv } from './runtime-env';

// ECONNRESET / EPIPE are normal client-disconnect events on a TCP server.
// Without this handler Node.js crashes the process on unhandled 'error' events
// from sockets that lose their connection unexpectedly.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
  console.error('[fatal] uncaught exception:', err);
  process.exit(1);
});

async function main(): Promise<void> {
  console.log(`[boot] role=${runtimeEnv.role}`);
  if (runtimeEnv.runsGateway) {
    const { bootGateway } = await import('./boot-gateway');
    bootGateway();
  } else {
    const { bootNode } = await import('./boot-node');
    bootNode();
  }
}

main().catch(err => {
  console.error('[fatal] failed to start:', err);
  process.exit(1);
});
