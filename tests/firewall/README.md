# Huddle firewall compatibility test

One **runtime-agnostic** end-to-end test for the Huddle firewall, run across the
operating-system × container-runtime matrix by
[`.github/workflows/compat-firewall.yml`](../../.github/workflows/compat-firewall.yml).
The workflow only chooses the platform and the runtime; **all** the test logic
lives here, so the same scenario runs locally and in CI.

## The test (milestone 1 — firewall basics)

1. Activate the requested container runtime (`docker` or `podman`).
2. Install/start Huddle via its own CLI (the real `huddle init` path), using a
   locally built gateway image (no registry pull).
3. Start a **minimal test devcontainer** — a tiny public `curl` image attached
   only to Huddle's internal network, so its sole route out is the proxy. It
   gets the same proxy env + CA that `huddle migrate` injects into real
   devcontainers, without pulling the large IDE base images.
4. Assert an **allowed** URL is reachable after an allow rule (`200`).
5. Assert a **blocked** URL stays unreachable (default-deny `403`).
6. *(optional)* **Path mode**: an allowed path prefix reaches upstream while a
   sibling path on the same host is blocked (`403`).
7. Collect the Huddle logs into `.logs/`.
8. Always clean up (containers, network, test client) — even when a check fails.

## Layout

```
tests/firewall/
  run-test.sh            # Linux & macOS runner (bash)
  run-test.ps1           # Windows runner (PowerShell 7)
  huddle-test-config/
    cases.env            # shared test cases (domains, URLs, expected codes)
  .logs/                 # collected Huddle logs (git-ignored, CI artifact)
```

`cases.env` is the single source of truth for both scripts, so the assertions
stay identical everywhere. Every value can be overridden from the environment.

## Running locally

```bash
# Linux / macOS
tests/firewall/run-test.sh --runtime docker
tests/firewall/run-test.sh --runtime podman

# Windows
pwsh tests/firewall/run-test.ps1 -Runtime docker
```

Prerequisites: the chosen runtime is running, Node 20+ (to build the CLI on the
fly if `huddle` is not already on `PATH`), and outbound access to `example.com`
/ `example.org` for the "allowed" and "path mode" steps. `jq` enables the path
mode step in the bash runner (PowerShell parses JSON natively); without it that
optional step is skipped.

### Useful overrides

| Variable | Default | Meaning |
|----------|---------|---------|
| `HUDDLE_RUNTIME` | — | runtime, same as `--runtime` |
| `HUDDLE_URL` | `http://localhost:3000` | Huddle management API |
| `HUDDLE_OPERATOR_TOKEN` | random | operator token (generated if unset) |
| `HUDDLE_IMAGE` | built locally | skip the gateway build, use this image |
| `HUDDLE_TEST_PATHMODE` | `auto` | `0` / `--no-pathmode` to skip path mode |
| `HUDDLE_TEST_LOG_DIR` | `tests/firewall/.logs` | where logs land |

## The CI matrix

The full 3×3 matrix is defined from the start. Only the combinations that work
headless on GitHub-hosted runners run for real today; the rest are visible but
marked `hosted: false` and reported as **planned** until a self-hosted runner
exists.

| OS \ runtime | Docker | Rancher Desktop | Podman |
|--------------|--------|-----------------|--------|
| **Linux**    | ✅ hosted | ⏳ self-hosted | ✅ hosted *(experimental)* |
| **Windows**  | ⏳ self-hosted | ⏳ self-hosted | ⏳ self-hosted |
| **macOS**    | ⏳ self-hosted | ⏳ self-hosted | ⏳ self-hosted |

Docker Desktop and Rancher Desktop cannot be installed headlessly on hosted
runners, so those combinations wait for self-hosted runners. To enable one,
flip `hosted: true` for its row in the workflow.

## Next steps

- Wire the runner behind a single command, e.g. `huddle test firewall`, so the
  suite is reachable from the CLI as well as the scripts.
- Add scenarios beyond the firewall: Spring Boot, .NET Aspire, WebSockets,
  volumes, and the filtered Docker socket — reusing the same matrix.
