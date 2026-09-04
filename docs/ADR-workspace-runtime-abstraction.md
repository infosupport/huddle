# ADR: Pluggable workspace runtime — Docker container ↔ sbx microVM (parallel, selectable per start)

**Status:** Accepted direction (2026-08-14), grounded in a live PoC. Implementation phased (§6).
**Audience:** an engineer/agent who will implement this. Everything you need is here or in the referenced code/docs.
**Companion docs:**
- `docs/ADR-hardening-proxy-and-docker-guard.md` — the security model this must preserve; Phase 1/A1 there ("move the isolation boundary lower") is the strategic sibling.
- `README.md` §Architecture — the egress/Docker-socket split.

**Decision in one paragraph.** Keep Huddle's **frontend, database, and proxy**. Introduce a **second box type** alongside today's Docker devcontainer: a **Docker Sandboxes microVM ("sbx" box)**. The two run **in parallel** — you choose, per workspace, which to start (`container` or `sbx`). Huddle's DB stays the **single source of truth** for firewall rules. In sbx mode, because the sbx daemon (not Huddle) is the only party that can tell one sandbox from another, **per-sandbox firewall enforcement is delegated to sbx**: Huddle **syncs** the ruleset (global + per-sandbox) *into* sbx's own policy engine (Huddle → sbx, one-way). Huddle remains the **upstream proxy** for **audit** and **TLS on/offloading**, and enforces at **fleet level** — but at the proxy it **cannot attribute a request to a specific sandbox** (proven below), so per-sandbox truth lives in sbx.

---

## 1. Why this shape — PoC findings (2026-08-14)

A live PoC forced an sbx microVM's egress through Huddle (via `sbx settings set proxy … localhost:32768` → host-forward → Huddle:80) with a gated identity probe (`gateway/src/identity-probe.ts`, `HUDDLE_IDENTITY_PROBE=1`). Findings:

1. **microVM isolation.** *"Docker Sandboxes run AI coding agents in isolated microVM sandboxes."* Each has *"its own Docker daemon, filesystem, and network."* Trust boundary: *"The primary trust boundary is the microVM. The agent has full control inside the VM, including sudo access."* → The VM boundary replaces Huddle's per-container Docker-socket policy; that whole layer (`socket-proxy.ts` + `docker-actions.ts`) is **dropped** in sbx mode.

2. **Egress is already forced, host-side, deny-by-default.** *"All outbound traffic from the sandbox routes through an HTTP/HTTPS proxy on your host"*, *"deny-by-default"*, *"non-HTTP protocols blocked entirely."* Enforcement is **outside the guest** — a root process in the sandbox cannot bypass it. Huddle plugs in as the **upstream proxy**.

3. **The upstream proxy is GLOBAL to the sbx daemon — no per-sandbox override.** *"All sandboxes running under a daemon use the same upstream proxy configuration … you cannot configure different proxies for different sandboxes."* The probe confirmed it: every sandbox's traffic arrives at Huddle from a single aggregated address with one shared credential:
   ```
   {"source":"connect","remoteAddress":"192.168.127.1","target":"test.be:80",
    "proxyAuthUser":"sbx-alpha","headers":{"user-agent":"sbx-proxy", ...}}
   ```
   `192.168.127.1` = the sbx host-proxy gateway; `sbx-alpha` = the **global** credential (same for all sandboxes). **⇒ Neither source-IP nor a per-token identity works at Huddle's proxy.** Huddle can prove *"this is our sandbox fleet"* but not *which* sandbox.

4. **Everything reaches Huddle as a CONNECT tunnel** (even plain `:80`), client `user-agent: sbx-proxy`. → Huddle can still **MITM-terminate** (TLS on/offload) for audit and path rules, provided its CA is trusted inside the sandbox.

   **Correction (measured 2026-08-16): not everything is tunnelled — sbx MITMs some hosts itself.** In a live sandbox, `github.com` presents `CN=Huddle DMZ Proxy Root CA` (tunnelled, Huddle terminates) but `platform.claude.com` presents `CN=Docker Sandboxes Proxy CA` — sbx terminates that one. For those hosts the upstream leg to Huddle is dialled by the **sbx daemon**, a host process validating against the **host** trust store. So Huddle's CA must be trusted in **two** places: inside the sandbox (`sbx.ts:trustCa`) *and* on the host (`cli/src/sbx-host-ca.ts`, run by `huddle init` / `huddle sbx trust-host`). Symptom when the host half is missing: the client handshake succeeds, then the connection closes with no response — `curl: (52) Empty reply from server`, and Claude Code reports `ECONNRESET` on platform.claude.com.

5. **sbx has its own per-sandbox network policy and audit.** `sbx policy allow/deny network <domain>` (wildcards `*.`/`**.`, CIDR, ports — **no path patterns**), plus *"sandbox-scoped rules"* and a per-sandbox traffic log. → **sbx is the right place to enforce per-sandbox rules**, because it is the party that knows the identity.

**Conclusion:** don't fight the platform for per-sandbox identity at the proxy. Split responsibilities — Huddle owns truth/UI/audit/TLS and fleet-level enforcement; sbx owns per-sandbox enforcement, fed by a one-way sync from Huddle.

---

## 2. Target architecture

Two runtimes behind one abstraction, selectable at start:

```
                     ┌───────────────────────── Huddle (unchanged frontend + DB + proxy) ─────────────────────────┐
                     │  Angular UI · Fastify API · SQLite (SOURCE OF TRUTH for rules) · audit log · TLS-CA        │
                     └───────────────┬───────────────────────────────────────────────┬───────────────────────────┘
                                     │ WorkspaceRuntime abstraction                   │
              ┌──────────────────────┴───────────────┐               ┌───────────────┴───────────────────────────┐
              │  kind = 'container'  (today)          │               │  kind = 'sbx'  (new, parallel)             │
              ├───────────────────────────────────────┤               ├────────────────────────────────────────────┤
 provisioning │  docker.ts: dc-net-*, exec config,    │               │  sbx run/create/ls/stop/rm/exec/cp          │
              │  in-container iptables, socket-proxy   │               │  CA via kit → update-ca-certificates        │
 egress path  │  container → Huddle proxy (:80)        │               │  sandbox → sbx host-proxy → Huddle upstream │
 enforcement  │  Huddle proxy enforces per-container   │               │  ① sbx policy enforces PER-SANDBOX (synced) │
              │  + global (as today)                  │               │  ② Huddle proxy: audit + TLS on/off +       │
              │                                       │               │     FLEET-level (can't attribute per-sbx)   │
 identity     │  source-IP → container (label cache)  │               │  fleet only at proxy; per-sbx lives in sbx  │
 DinD policy  │  socket-proxy + docker-actions        │               │  none (microVM boundary)                    │
              └───────────────────────────────────────┘               └────────────────────────────────────────────┘

Rule sync (sbx mode):   Huddle DB  ──one-way projection──▶  sbx policy   (global rules + per-sandbox rules)
                        Huddle is authoritative; sbx is a projection, never a second source of truth.
```

**In the sbx-mode data path both layers are traversed:** the sandbox's traffic first hits the **sbx host-proxy** (which applies the synced `sbx policy`, per-sandbox, deny-by-default), and allowed traffic is then forwarded **upstream to Huddle**, which does TLS on/offload, audit, and fleet-level checks before egressing. Two enforcement points, defence-in-depth, with Huddle as the single authoring surface.

---

## 3. The abstraction

`WorkspaceRuntime` in the gateway, *above* the existing engine-selection `ContainerRuntime` (`cli/src/runtime.ts`). Two implementations: `DockerWorkspaceRuntime` (today's `docker.ts`, verbatim) and `SandboxWorkspaceRuntime` (`sbx`).

```ts
// gateway/src/runtime/workspace-runtime.ts  (new)
export interface WorkspaceRuntime {
  readonly kind: 'container' | 'sbx';

  // Lifecycle
  provision(spec: WorkspaceSpec): Promise<WorkspaceHandle>;
  start(handle: WorkspaceHandle): Promise<void>;
  destroy(handle: WorkspaceHandle): Promise<void>;
  snapshot(handle: WorkspaceHandle, name: string): Promise<ImageRef>;  // ⚠ no sbx equivalent (§7)
  list(): Promise<WorkspaceHandle[]>;

  // In-workspace access
  exec(handle: WorkspaceHandle, cmd: string[]): Promise<ExecResult>;
  injectConfig(handle: WorkspaceHandle, files: ConfigFile[]): Promise<void>;
  openTerminal(handle: WorkspaceHandle): Promise<Channel>;

  // Egress + identity
  bindEgress(handle: WorkspaceHandle): Promise<void>;            // container: iptables; sbx: no-op (global upstream)
  resolveIdentity(signal: IdentitySignal): Promise<string | null>; // container: per-container; sbx: fleet only

  // Firewall enforcement placement
  readonly enforcement: 'proxy' | 'delegated';                  // container: 'proxy'; sbx: 'delegated'
  syncRules?(rules: RuleProjection): Promise<void>;             // sbx: project Huddle's ruleset into sbx policy

  readonly dindPolicy: DindPolicy;                              // container: socket-proxy; sbx: none
}
```

`WorkspaceSpec` derives from today's `StartParams` (same field names, mechanical migration).

### Who implements what

| Concern | `DockerWorkspaceRuntime` | `SandboxWorkspaceRuntime` |
|---|---|---|
| provision/start/destroy | `createAndStartContainer` / `startExistingContainer` / `forceDeleteContainer` (`docker.ts:913/512/508`) | `sbx create/run`, `sbx stop`, `sbx rm [--force]` |
| snapshot | `commitContainer` (`docker.ts:391`) | ⚠ no documented `sbx` equivalent (§7) |
| list | label filter (`docker.ts:128`) | `sbx ls` |
| exec / terminal | `docker exec` (`docker.ts:236/290`, `terminal.ts`) | `sbx exec -it <n> …` |
| injectConfig / CA | config script via exec (`docker.ts:633/792/686`) | `sbx cp` / kit (`sbx run --kit`) + `update-ca-certificates`; don't touch `SSL_CERT_FILE` |
| bindEgress | env + iptables DNAT/DROP + `--internal` net | global upstream (`sbx settings set proxy … <huddle>`); host-side, deny-by-default already |
| resolveIdentity | source-IP label cache (`docker.ts:76` → `proxy.ts:344`) | **fleet only** — proves "our fleet", not which sandbox |
| enforcement | `'proxy'` (Huddle enforces) | `'delegated'` (sbx enforces) + Huddle fleet/audit/TLS |
| syncRules | — (proxy reads DB live) | project DB → `sbx policy allow/deny network …` (global + per-sandbox) |
| dindPolicy | socket-proxy + docker-actions | none |

---

## 4. Rule model & sync (sbx mode)

**Huddle's SQLite `rules` table stays the single source of truth.** Nothing about authoring, the UI, groups, export/import, or `/api/rules*` changes. What changes is *where enforcement happens* per runtime.

- **container mode:** unchanged — Huddle's proxy reads the DB live and enforces per-container + global (existing behaviour, existing contract).
- **sbx mode:** Huddle **projects** the ruleset into sbx's policy engine and lets sbx enforce per-sandbox:
  - global allow/deny **domain** rules → sbx global policy (`sbx policy allow/deny network <domain>`);
  - per-container rules → sbx **sandbox-scoped** rules, keyed by the sandbox name (exact CLI: confirm `sbx policy … --sandbox <name>` via `sbx policy --help` — the docs reference *"sandbox-scoped rules"* but not the flag syntax);
  - **one-way** (Huddle → sbx). sbx is a **projection**, never a second source of truth. Reconcile on drift: on rule change and on sandbox create/restart, recompute and re-push; treat any local sbx rule not originating from Huddle as drift to be removed.

### Consequences / limits of the projection (be honest about these)
1. **`sbx policy` is domain-level only — no path patterns.** So **path-mode rules cannot be delegated** to sbx. Path enforcement can only happen at Huddle's MITM proxy, which in sbx mode is **fleet-level** → **per-sandbox path rules are not enforceable in sbx v1.** Global path rules still work at Huddle (fleet-wide). Document this in the UI (grey out per-sandbox path rules in sbx mode, or scope them global).
2. **Discovery / request→approve loop.** sbx is deny-by-default and enforces *before* forwarding upstream, so a blocked domain never reaches Huddle's proxy — Huddle's auto-`requested` mechanism (which relies on seeing the request) won't fire from the proxy. To preserve the approve-in-portal UX, Huddle must **ingest sbx's per-sandbox deny log** (`sbx policy log`) and surface those as `requested` rows; approving writes a rule → sync → sbx allows it. (Alternative: run sbx policy permissive and let Huddle enforce — but that forfeits per-sandbox enforcement, the whole point. Rejected.)
3. **Organization governance precedence.** Docker docs: *"when organization governance is active, only organization allow rules grant access; local allow rules are inactive, local deny still applies."* So on org-governed machines Huddle's **synced allow** rules may be inert while its **deny** rules still bite. Detect this and warn the operator; Huddle's authoring can't override org policy.

---

## 5. Enforcement responsibility matrix

| Capability | container mode | sbx mode |
|---|---|---|
| Per-container **domain** allow/deny | Huddle proxy | **sbx** (synced), per-sandbox |
| Global **domain** allow/deny | Huddle proxy | sbx (synced) + Huddle fleet |
| **Path**-level rules | Huddle proxy (per-container + global) | Huddle proxy **fleet-only**; per-sandbox path rules **unsupported** (§4.1) |
| Audit / network log | Huddle proxy | Huddle proxy (fleet attribution) + optional `sbx policy log` ingest for per-sandbox |
| TLS on/offloading (MITM) | Huddle proxy | Huddle proxy (CA installed in sandbox via kit) |
| Request→approve discovery | Huddle proxy (auto-`requested`) | via `sbx policy log` ingest (§4.2) |
| Identity precision | per-container | fleet at proxy; per-sandbox only inside sbx |
| DinD control | socket-proxy + grants | dropped (microVM boundary) |
| Snapshot/commit | `docker commit` | ⚠ gap (§7) |

---

## 6. Workstreams

### Phase 0 — extract the seam (pure refactor, zero behaviour change)
1. Define `WorkspaceRuntime`/`WorkspaceSpec`/`WorkspaceHandle`/`IdentitySignal`/`RuleProjection` in `gateway/src/runtime/workspace-runtime.ts`.
2. Move today's `docker.ts` lifecycle behind `DockerWorkspaceRuntime` (`enforcement: 'proxy'`, no `syncRules`). No logic change.
3. Route `api.ts` (`/api/docker/*`), `index.ts` recovery, `proxy.ts` identity (`:344`), `terminal.ts` through the interface.
4. Repoint the stubbed `gateway/src/workspace-flow/` (feature 08) at `WorkspaceSpec`/`WorkspaceRuntime`.
5. **Gate:** full `gateway/test/e2e` + smoke run pass unchanged.

### Phase 1 — `SandboxWorkspaceRuntime` provisioning (flag-gated, default `container`)
1. Setting/flag `workspaceRuntime` **selectable per start** (not just per deployment) — the UI "Start" dialog and CLI both offer `container | sbx`.
2. Provision via `sbx` (`create/run/ls/stop/rm/exec/cp`); CA via kit; Huddle as global upstream (`sbx settings set proxy`); TLS on/offload verified end-to-end.
3. `resolveIdentity` returns the fleet id at the proxy; wire audit to record fleet + target (per-sandbox column empty for now).
4. IDE/terminal via `sbx exec` — validate JetBrains Gateway / VS Code attach (highest UX risk).

### Phase 2 — rule-sync engine (DB → sbx policy)
1. `syncRules` projection: DB rules → `sbx policy` (global + sandbox-scoped); reconcile on rule change and sandbox lifecycle; remove drift.
2. Confirm the per-sandbox `sbx policy` scoping syntax (`sbx policy --help`).
3. Ingest `sbx policy log` → `requested` rows to keep the approve-in-portal UX (§4.2).
4. UI: in sbx mode, mark per-sandbox **path** rules unsupported (§4.1); detect org-governance precedence and warn (§4.3).

### Phase 3 — CLI + migration ergonomics
1. `huddle init --workspace-runtime <container|sbx>` / `HUDDLE_WORKSPACE_RUNTIME`; per-start override on `huddle` / the Start dialog.
2. "Leaving Huddle" story: sbx workspace is a plain machine behind an HTTP proxy — `sbx settings set proxy direct` and it's Huddle-free.

---

## 7. Consequences, gaps, open questions

**Accepted consequences**
- Network-log per-sandbox attribution is **best-effort** in sbx mode (fleet at the proxy; per-sandbox only via `sbx policy log` correlation).
- **Per-sandbox path rules are unsupported** in sbx v1 (sbx policy has no path patterns).
- **Two enforcement engines** (Huddle proxy + sbx policy) must be kept in sync — drift is a real risk; the projection is one-way and reconciled, and sbx is never authoritative.
- **Snapshot/commit gap**: no documented `sbx` equivalent of `docker commit`; bake images out-of-band or accept no-snapshot in sbx v1.

**Open questions to close before/within Phase 2**
1. Exact `sbx policy` per-sandbox scoping syntax (docs reference *"sandbox-scoped rules"* but not the flag) — `sbx policy --help`.
2. Can Huddle read `sbx policy log` programmatically (format, streaming) for the discovery loop?
3. Ordering assumption: sbx applies its policy *before* forwarding upstream to Huddle — verify empirically with the probe.
4. Does the sbx host-proxy strip/replace a guest-supplied `Proxy-Authorization` (spoofability of any fleet credential)? PoC suggested the outer CONNECT carries only the global credential; confirm.

---

## 8. References
- **Code:** `gateway/src/docker.ts`, `proxy.ts`, `rules.ts`, `socket-proxy.ts`, `docker-actions.ts`, `api.ts`, `index.ts`, `terminal.ts`, `identity-probe.ts`, `workspace-flow/`; `cli/src/runtime.ts`, `cli/src/init.ts`.
- **This repo:** `docs/ADR-hardening-proxy-and-docker-guard.md`, `README.md` §Architecture.
- **Docker Sandboxes (fetched 2026-08-14):** `/ai/sandboxes/`, `/ai/sandboxes/architecture/`, `/ai/sandboxes/security`, `/ai/sandboxes/upstream-proxy/`, `/ai/sandboxes/troubleshooting/`, `/ai/sandboxes/usage/`, `/ai/sandboxes/governance/access-controls/network/`, `/reference/cli/sbx/`.
  Verbatim anchors: microVM isolation; per-sandbox daemon/fs/network; trust boundary = the microVM; host-side deny-by-default egress proxy, non-HTTP blocked; **upstream proxy is global to the daemon, no per-sandbox override**; identity stays host-side; CA installed *inside* the sandbox (kit / `update-ca-certificates`), don't override `SSL_CERT_FILE`; `sbx policy allow/deny network <domain>` (wildcards/CIDR/ports, no paths) with *"sandbox-scoped rules"*; org governance overrides local allow (local deny still applies); lifecycle `sbx run/create/ls/stop/rm/exec/cp`.
- **PoC evidence:** identity probe on the CONNECT path showing aggregated `192.168.127.1` + shared `sbx-proxy` credential (§1.3).
</content>
