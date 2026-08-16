# `sbx` CLI surface (host-agent passthrough)

The exact `sbx` command surface the host-agent relies on, derived from
[`host-agent/src/sbx.ts`](../host-agent/src/sbx.ts). The host-agent is a **thin
passthrough**: it validates inputs, builds an argv array, and runs the `sbx`
binary via `execFile` (non-streaming) or `spawn` (streaming) — **never a shell**.
For the wire protocol that fronts this surface, see
[`docs/host-agent-protocol.md`](./host-agent-protocol.md); for the design rationale
and open questions, see [`docs/ADR-workspace-runtime-abstraction.md`](./ADR-workspace-runtime-abstraction.md).

## Method → argv mapping

`<sbx>` is the binary named by `HUDDLE_SBX_BIN` (default `sbx`). Every `<name>`,
`<agent>`, and `<target>` below is **validated before** it reaches the argv (see
"Validation" in the protocol doc). `[...]` denotes conditional args.

| Host-agent method | `sbx` argv | Run mode |
|---|---|---|
| `sbx.version` | `sbx version` | `execFile` |
| `settings.setProxy` | `sbx settings set <key> <url>` where `<key>` = `proxy.sandbox` \| `proxy.daemon` \| `proxy` | `execFile` |
| `sandbox.create` | `sbx create --name <name> <agent> <path>` | `spawn` (streaming) |
| `sandbox.list` | `sbx ls` | `execFile` |
| `sandbox.remove` | `sbx rm [--force] <name>` | `execFile` |
| `sandbox.exec` | `sbx exec [-it] <name> -- <cmd...>` | `spawn` (streaming) |
| `sandbox.sshSetup` | `sbx setup ssh` | `execFile` |
| `policy.set` | `sbx policy <allow\|deny> network <target> [--sandbox <name>]` | `execFile` |
| `policy.list` | `sbx policy list [--sandbox <name>]` | `execFile` |
| `policy.remove` | _(none — throws; see OPEN §2)_ | — |

### Detail notes

- **`settings.setProxy` key selection** (`SetProxyParams.which`):
  - `'sandbox'` → **`proxy.sandbox`** (default for `sandbox.create`'s `proxySandbox`)
  - `'daemon'` → `proxy.daemon`
  - `'both'` → `proxy` (the umbrella key)
  - `proxy.sandbox` (not `proxy`) is used for the sandbox path so **daemon
    auth/registry traffic stays direct** — see the ADR.
- **`sandbox.create`**: if `CreateParams.proxySandbox` is set, the agent runs
  `settings.setProxy({which:'sandbox', url})` **first** (a separate `sbx settings
  set proxy.sandbox <url>` call) before `sbx create`. The agent positional is
  `CreateParams.agent` or `HUDDLE_SBX_AGENT` (default `claude`), validated by
  `AGENT_RE` so it can never begin with `-`.
- **`sandbox.exec`**: the user command is passed after a literal `--`, so it can
  never be reinterpreted as `sbx` flags. `-it` is added only when `tty` is set.
- **`--sandbox <name>` scope flag** (`policy.set` / `policy.list`) is added only
  for `scope.kind === 'sandbox'`; global scope adds nothing. **This flag is an
  unverified best guess** — see OPEN §1.

## Output parsing

### `parseSbxLs(stdout)` — `sbx ls` → `SandboxInfo[]`

Handles docker-style tabwriter output. Defensive and never throws:

- If a **header row** is present (first token is `name`, case-insensitive, or the
  line contains a `NAME` word), its column start-offsets are captured and used for
  **fixed-width slicing** of subsequent rows. This is needed because a `STATUS`
  value can contain spaces (e.g. `Up 2 hours`), which whitespace-splitting would
  mangle. The header row is consumed, not emitted.
- With header offsets, each row is sliced per column; `name` is taken from the
  `name` column (fallback: first whitespace token), and `status` from the `status`
  or `state` column.
- **No header** → fallback: first whitespace token is `name`, the rest joined is
  `status`.
- Blank lines are skipped; unknown columns are ignored. Each emitted row also
  carries `raw` (the trimmed source line).

### `parsePolicyList(stdout)` — `sbx policy list` → `PolicyRule[] | null`

**Best-effort**, because the real output format is not yet confirmed (TODO in
code). Strategy per non-empty line:

- Find an `allow`/`deny` verb (word-boundary, case-insensitive). Lines with no
  verb that look like headers (`NAME`/`ACTION`/`TARGET`/`SCOPE`/`RULE`/`POLICY`)
  are skipped; any other verbless line is also skipped.
- **Scope**: a `--sandbox <name>` or `sandbox=<name>` / `sandbox:<name>` hint →
  `{kind:'sandbox', name}` (validated); otherwise `{kind:'global'}`.
- **Target**: the first token (other than the verb or the literal `network`) that
  looks like a host / wildcard / `host:port` / CIDR — i.e. contains `.`, `:`, `/`,
  or `*` — and passes `isValidPolicyTarget`. A line with no such token is skipped.

Return-value contract (so the caller can degrade gracefully):

| Output | Return |
|---|---|
| genuinely empty output | `[]` |
| non-empty but **no `allow`/`deny` verb anywhere** (unrecognised format) | `null` |
| recognisable | `PolicyRule[]` (possibly empty if lines had verbs but no valid target) |

`policyList()` treats `null` as "unrecognised format": it logs a breadcrumb
(`[host-agent] policy.list: unrecognised … output; returning []`) and returns
`[]` rather than surfacing garbage or crashing.

### Docker-login error detection

`detectDockerLoginError(...texts)` scans combined stdout/stderr (lower-cased) for
`invalid_grant`, `refresh token`, or `login.docker.com`, and if matched returns a
single actionable message:

> `Docker login required on the host: run` `docker login` `(the current Docker credentials are missing, expired, or revoked).`

Returns `null` when no match (caller falls back to the raw error). This upgrade is
applied by `create`, `remove`, `exec`, `sshSetup`, and the shared `throwSbxError`
helper (used by `version`, `setProxy`, `policySet`, `policyList`, `list`). For the
streaming ops (`create`/`exec`) only the last 64 KiB of stderr is retained for this
check; a matched login error is thrown as an `ok:false` Response even though the
raw exit would otherwise be returned as `{exitCode}`.

## Environment knobs

| Var | Default | Meaning |
|---|---|---|
| `HUDDLE_SBX_BIN` | `sbx` | Path to the `sbx` binary (used by both `execFile` and `spawn`). On `ENOENT` the agent returns a clean `'<bin>' not found on PATH` error and never crashes. |
| `HUDDLE_SBX_AGENT` | `claude` | Default agent positional for `sandbox.create` when `CreateParams.agent` is unset. |
| `HUDDLE_SBX_TIMEOUT_MS` | `300000` | Per-command timeout for the **non-streaming** (`execFile`) path. On timeout the run resolves with exit code `124`. (Streaming `spawn` runs are not bounded by this timeout; the gateway client's request timeout — 320 s — bounds them end to end.) |

`runSbx` also caps captured output at `maxBuffer: 32 MiB` and resolves even on
non-zero exit (it never rejects; callers decide what a non-zero code means).

## OPEN / TODO — verify on a real host

Mirrors the ADR §7 open questions. Everything here is **unconfirmed against a real
`sbx`** and is marked with a `TODO(...)` in `sbx.ts`.

1. **Per-sandbox `sbx policy` scope flag** — `scopeArgs()` emits `--sandbox <name>`
   for sandbox scope, but this is a best guess. Confirm the real flag via
   `sbx policy --help`. Affects `policy.set` and `policy.list`.
   (`TODO(T0.3/T1.3)`)
2. **Policy removal verb** — `policyRemove()` **deliberately throws**
   (`policy.remove not yet implemented …`) instead of guessing. Confirm the verb
   (likely `sbx policy remove network <target> [--sandbox <name>]` or a `--delete`
   flag) before wiring it. Kept explicit so reconciliation can't assume success.
   (`TODO(T1.3)`)
3. **SSH setup verb** — `sshSetup()` runs `sbx setup ssh`; confirm whether it is
   `sbx setup ssh` or `sbx ssh setup`. (`TODO(T2.3)`)
4. **`sbx policy list` format** — confirm the real output and tighten
   `parsePolicyList` (currently best-effort, degrades to `[]`). (`TODO(T1.3)`)
5. **`sbx policy log` machine-readability** — for the discovery / request→approve
   loop, confirm whether `sbx policy log` is machine-readable/streamable so Huddle
   can ingest per-sandbox denies as `requested` rows (ADR §4.2). Not yet
   implemented in the agent.
6. **Global-upstream-proxy constraint** — the sbx upstream proxy is **global to
   the daemon; there is no per-sandbox proxy override** (ADR §1.3). `settings.setProxy`
   with `which:'sandbox'` sets the daemon-wide `proxy.sandbox` key; it does **not**
   scope a proxy to one sandbox. Per-sandbox differentiation is done via
   `sbx policy` rules, not per-sandbox proxies.
