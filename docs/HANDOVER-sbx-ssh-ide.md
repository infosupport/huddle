# Handover: base image unification, SSH access, and the sbx proxy CONNECT fix

Branch: `feat/sbx-sandboxes-rebased`. Commits: `ab8a4a1`, `4e64478`, `955f37a`
(plus the pre-existing history on the branch). This doc explains what those
commits do, why, how to run/verify them locally, and what's still open.

## 1. Background / plan

Full design context and the original rationale live in the plan this work
followed — see the "Unify devcontainer + sbx onto a slim SSH-accessible
image with runtime IDE install" plan. Short version: `pocsshcontainers/` was
a tested POC showing a better shape than Huddle's build-time
`base-devimage` + `base-devimage-{intellij,rider,vscode}` image matrix — one
slim SSH-accessible base image, with the JetBrains/VS Code backend
installed **at runtime** by a shared `install-ide.sh`. The user asked to
bring this into both devcontainers and sbx (Docker Sandboxes), and to add
SSH key-based access as a new connect path alongside the existing
docker-exec portal terminal and docker-attach IDE flows.

## 2. `feat(devcontainer,sbx)`: image unification + SSH + IDE install (`ab8a4a1`)

### Base image
- `base-devimage-{intellij,rider,vscode}/` (each just 2 `LABEL`s) are
  deleted. `base-devimage/Dockerfile` is now the only image, with sshd and
  the Rider runtime libs the POC identified added to it.
- `gateway/src/docker.ts`'s `getBaseImageName()` no longer takes an `ide`
  param — one image name for everything.
- CI (`publish-image.yml`, `experiment-publish.yml`,
  `publish-experiment.yml`, `test.yml`) collapsed from a 4-image matrix to 1.
- Known accepted side effect: `listSnapshotImages`'s
  `com.devcontainer.snapshot`/`com.devcontainer.ide` label filter will just
  stop matching anything now that the per-IDE image families are gone. Left
  as-is per the user's explicit "leave it, out of scope" direction — a
  follow-up item if snapshot listing needs to work again.

### Runtime IDE install
- `gateway/src/devcontainer-scripts/install-ide.sh` — ported from the POC.
  `install <ide> [pluginIds...]` / `run <ide> <host> <port>` subcommands.
  Delivered to both devcontainers and sbx sandboxes by base64-embedding it
  into the exec'd setup script (same idiom as CA cert delivery), so a script
  fix ships on next container/sandbox start with no image rebuild.
  `gateway/src/devcontainer-scripts.ts` + `gateway/scripts/copy-devcontainer-scripts.mjs`
  (invoked from `gateway/package.json`'s `build:ts`) get this file into
  `dist/` for a normal build; `build-sea.mjs` reads it straight from `src/`
  for the SEA binary build (see the comment there for why: `tsc` alone never
  populates `dist/` with non-`.ts` files, so routing through `dist/` there
  would add an ordering dependency on the copy script running first).
- `buildJbConfigScript`/`buildVscodeConfigScript` in `docker.ts` now always
  run `install-ide.sh install` synchronously (as `vscode`, not root) before
  writing `host-config.json` with `"deploy":"false"` — this deletes the old
  racy background-polling watcher and the previously `// UNVERIFIED`
  `installPlugins` invocation entirely.
- For sbx: `gateway/src/sbx.ts`'s `startSandboxExclusive` backgrounds
  `( install && run ) > /root/huddle-ide-install.log 2>&1 & disown` instead
  of blocking — sbx sandboxes have no shared dist-cache volume (unlike
  devcontainers' `jb_devcontainers_shared_volume`), so every install is a
  full ~1.5GB fresh download, and blocking `sbx create` on that would ruin
  sbx's near-instant-creation UX. sbx always runs as root, so
  `install-ide.sh` gained a `HUDDLE_SBX_ROOT=1` opt-out for its normal
  refuse-to-run-as-root guard.

### JetBrains connect link
- Rather than hand-building JetBrains Gateway's undocumented
  `jetbrains-gateway://connect#...` URL format, `install-ide.sh run` is
  invoked with `--ssh-link-host`/`--ssh-link-user`/`--ssh-link-port`, which
  makes the JetBrains backend **itself** print its own valid connect link to
  `$HOME/backend.log`. The gateway greps that log
  (`jetbrainsGatewayLink()` in `sbx.ts`) and returns it from
  `GET /api/sbx/sandboxes/:name/ssh-key` as `jetbrainsLink` — `null` while
  still installing. The frontend's "Open in IntelliJ" button
  (`container-detail.component.ts`'s `openJetbrains()`) fetches this route
  and either opens the link directly or shows "Still installing IntelliJ —
  try again in a bit".

### SSH access (new connect path)
- `gateway/src/ssh-keys.ts` — RSA-2048 keypair generation (same node-forge
  call as `tls-ca.ts`) + a fixed host port, stored in a new `ssh_access`
  table in `db.ts`. `provisionSshAccess`/`getSshAccess`/`dropSshAccess`,
  same mint/has/drop shape as the existing sandbox-identity table.
- Both devcontainers (`docker.ts`) and sbx (`sbx.ts`) bootstrap sshd via an
  exec'd script that installs the public key into `authorized_keys` and
  starts `sshd -D -e` backgrounded.
- New routes: `GET /api/docker/containers/:name/ssh-key` and
  `GET /api/sbx/sandboxes/:name/ssh-key` return the keypair + port (+
  `jetbrainsLink` for sbx).
- CLI: `cli/src/container.ts` (new) and `cli/src/ssh.ts` (new) give
  `huddle container ssh-setup <name>` / `huddle sbx ssh-setup <name>`,
  fetching the key and printing a ready `ssh -p <port> ...` command.
- Frontend (`container-detail.component.ts/.html`,
  `sandboxes.component.ts/.html`): SSH command and VS Code remote link now
  come from the real provisioned port (`localhost:<port>`) instead of a
  fake `<name>.sbx` DNS host that never existed.
- New firewall-rule groups: `examples/firewall-rules/jetbrains.json`
  (`download.jetbrains.com`, `plugins.jetbrains.com`,
  `downloads.marketplace.jetbrains.com`) and
  `examples/firewall-rules/openvscode-server.json` (GitHub release assets +
  Open VSX), needed by the runtime installs above.

## 3. `fix(proxy)`: sbx curl/CONNECT resets (`4e64478`)

**Reported symptom:** curl calls from inside sbx sandboxes failed with, on
Windows, `wsarecv: An existing connection was forcibly closed by the remote
host` — reproduced live via a `curl -v tst.nl` transcript from inside a real
sandbox showing a bare closed connection instead of an error body.

**Root cause:** `gateway/src/proxy.ts`'s raw (non-MITM) CONNECT tunnel
branch — taken for any CONNECT to a `NO_INTERCEPT_DOMAINS` entry, or any
port other than 443, which is exactly what a plain `http://` URL hits when
forwarded via CONNECT (e.g. `curl http://tst.nl/` → port 80) — did
`upstream.on('error', () => clientSocket.destroy())` on a dial/DNS failure:
a bare socket destroy with zero HTTP bytes written. The CONNECT client (the
sbx daemon) is mid-read waiting for a complete HTTP response at that
moment, so the bare destroy surfaces client-side as a raw low-level reset
instead of a legible error. The sibling MITM path (port 443) already
handled this correctly via `innerRes.writeHead(502, ...)`.

**Fix:** new `rejectSocketUpstreamError()` helper (mirrors the existing
`rejectSocket()` policy-denial helper) writes a proper `HTTP/1.1 502 Bad
Gateway` JSON body before closing. The raw-tunnel branch now tracks
`established` (true only once `net.connect`'s success callback has fired
and `200 Connection Established` has been written) and only takes the bare
`clientSocket.destroy()` path for **post-tunnel** errors, where the socket
already carries opaque piped bytes and there's no HTTP response left to
send. Covered by a new regression test in
`gateway/test/sbx-proxy-identity.test.ts` (CONNECT to a guaranteed-
unreachable port now gets a real 502 instead of a bare closed connection).

This was the actual bug behind the user's separate report that sbx's proxy
"routing" felt flaky and their suggestion to add a per-request identity
header. That header already exists and was not the problem: sbx's daemon
already sends `Proxy-Authorization` on every single request/CONNECT (not a
one-time credential swap), read by `identifySandbox()` in `proxy.ts` and
documented in `docs/ADR-sbx-identity.md`. The "park unclaimed after create"
dance elsewhere in `sbx.ts` is unrelated — it exists to stop a sandbox
created *outside* Huddle's involvement from acquiring a stale credential,
not to swap credentials live.

## 4. `chore(dev)`: parallel dev instance + parallel install (`955f37a`)

Requested to be called out explicitly in this handover:

- **`npm run dev:full -- up`** — starts a second, fully independent Huddle
  stack (`scripts/dev-full.mjs`) next to your normal install: its own
  gateway container, devcontainer network, and socket directory, all
  derived from `HUDDLE_INSTANCE`. Use this (instead of `dev:single`) when
  you need a real, separate running instance — e.g. to test devcontainer/sbx
  creation end-to-end — without touching your daily-driver Huddle. Both
  instances can run at once; devcontainers created under one never become
  visible to the other. The operator token is shared between the two so one
  login cookie works for both portals (see the comment in
  `scripts/dev-single.mjs` on why: browser cookies are scoped by domain,
  never by port, so two different tokens on two localhost ports would keep
  logging each other out).
- **`npm run dev:full -- down`** — tears that second instance back down.
- **`npm run install:parallel`** — runs `npm install` in `gateway/`,
  `gateway/frontend/`, and `cli/` concurrently instead of one after another
  (`scripts/install-parallel.mjs`). Useful after pulling a branch that
  touched dependencies in more than one subproject — plain `npm run
  install` (root) still does the same three installs serially and remains
  the default.

## 5. Verification status

- `npm --prefix gateway run build:ts` — clean.
- `npm --prefix gateway test -- sbx-proxy-identity` — 13/13 passing,
  including the new CONNECT-502 regression test.
- Frontend (`ng build`) was not end-to-end click-tested from this
  environment — this devcontainer session is itself sandboxed behind
  Huddle (per its own `CLAUDE.md`), with Docker-action restrictions that
  block rebuilding/redeploying a live instance from here. The user's actual
  dev/test Huddle instance runs natively on their own Windows machine.
- **Still needs live verification by the user on their own machine**: pull
  this branch, redeploy (`npm run dev:full -- down` then `up`, or your
  normal `huddle init` cycle), and confirm:
  - `curl` from inside an sbx sandbox to both a working and a broken host
    now returns a real error instead of a reset.
  - A fresh sbx sandbox actually installs the IntelliJ backend in the
    background and "Open in IntelliJ" opens the right environment directly
    once the install finishes.
  - SSH connects on the minted port for both a devcontainer and an sbx
    sandbox.

## 6. Known limitations / follow-ups (not addressed here)

- `listSnapshotImages`'s per-IDE image-label snapshot filter will stop
  matching anything now that the per-IDE image families are gone (accepted,
  out of scope per the user).
- sbx has no shared IDE-dist-cache volume, so every sandbox's backend
  install is a full fresh download (matches the POC's behavior; not treated
  as a bug).
- `sbx setup ssh` (`ops.sshSetup()`, still has a `// TODO(T2.3)` comment in
  `gateway/src/sandbox/ops.ts`) is intentionally NOT called from
  `startSandboxExclusive` — an earlier attempt showed it resets the shared
  CONNECT-proxy tunnel for every sandbox's egress, not just the one being
  set up. It's left as the explicit "Enable SSH" action a developer opts
  into deliberately, rather than something that runs automatically on every
  `sbx create`.
