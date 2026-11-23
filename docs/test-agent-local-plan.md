# Local test agent (runner mirror in a Linux VM)

Status: **first version written, not yet run.** `scripts/test-agent/run.sh`, `.github/agent/test-agent.md` and `.github/agent/playwright-mcp.json` exist. The first run in the VM will show what needs adjusting.

## Context

The Huddle PDF (Part 2, "Agent 2: Test agent", pp. 16-19) asks for an AI agent that uses a running, throwaway Huddle the way an operator and an attacker would:

- **Browser:** Playwright MCP against the portal on `localhost:3000`, logged in with a per-run operator token.
- **Shell:** `docker exec` into a target devcontainer, to send traffic from inside the boundary.
- **Fixed scenarios** (firewall, HTTPS interception, bypass attempts, docker socket, sudo grant, portal), each checked against an expected result.
- **Output:** one pass/fail line per area. Details of a failed security check never appear in public output. Confirmed findings later become deterministic tests in `gateway/test/e2e/`.

In CI it runs on a throwaway GitHub runner. A developer PC has no such runner, and running the agent inside the main Huddle is paradoxical: the target Huddle needs a Docker socket to create devcontainers, and the main Huddle exists to keep that away from the agent.

## Decision: a disposable Linux VM is the runner

The first plan used a Docker-in-Docker arena on Rancher Desktop. That is replaced by a **Hyper-V Ubuntu VM** with the repo checked out on `feat/test-agent`. The VM is the isolation boundary, exactly like the GitHub runner, so `run.sh` is a one-to-one mirror of the CI job: the same steps run directly on the VM's own Docker.

Isolation rules for the VM:

- No Hyper-V Enhanced Session, shared folders or clipboard sharing with the PC.
- No credentials that can push to GitHub or reach anything else (a read-only checkout is enough). The agent has the `Read` and `Write` tools on the VM.
- Take a Hyper-V checkpoint of the clean state and restore it after runs you do not trust.
- `run.sh` refuses to run on anything that does not look like a VM (`systemd-detect-virt --vm`).

## Choices taken from the PDF

| Question | Answer | Source |
|---|---|---|
| Which scenarios? | All of the fixed list, every run | p. 16-17 table |
| API key? | Environment variable on the runner (the VM), never inside the target container. The agent's only shell is `docker exec target-dc`. | p. 18, p. 21 ("keep the key on the runner outside the devcontainer") |
| Network? | Open, like the GitHub runner, which sits outside Huddle's firewall | p. 15, p. 18 |
| Where do findings go? | Locally: `findings.md` in the run's output folder, nothing posted. In CI later: private repo via a separate step. | p. 18-19, p. 23 |
| Login of the browser? | The operator token is a session cookie (`huddle_session`). `run.sh` puts it in a Playwright storage-state file, so the agent never sees the token. | `gateway/src/auth.ts` |
| Tool allowlist | `mcp__playwright__*`, `Bash(docker exec target-dc:*)`, `Read`, `Write`. Added: `Bash(docker exec -u root target-dc:*)` (the sudo scenario needs root in the target). | p. 19 |

## What `run.sh` does (mirrors the CI job)

1. Preflight: Linux, in a VM, tools present, `ANTHROPIC_API_KEY` set, no leftovers of an earlier run.
2. Build `huddle:pr` from `gateway/`; pull `base-devimage` and `base-devimage-vscode` (build from this checkout when the pull fails or `TEST_AGENT_BUILD_BASE=1`).
3. Start Huddle like the `e2e` job in `.github/workflows/test.yml` (internal `devcontainer-net`, random `HUDDLE_OPERATOR_TOKEN`, Docker socket and `/tmp/dc-sockets` mounted, then `docker network connect bridge huddle`). The port is bound to `127.0.0.1` only.
4. Create the target devcontainer `target-dc` through Huddle's API (`POST /api/docker/start`), as `spawnDevcontainer` does in `gateway/test/e2e/helpers.ts`.
5. Run `claude -p` with the prompt, the Playwright MCP config (`--strict-mcp-config`), the allowlist and `--max-turns 60`, in a scratch folder.
6. Print `report.md`, keep `evidence.md`, `findings.md` and `huddle.log` (the network log) in the output folder, remove the Huddle stack.

Exit code: 0 no failures, 1 an area failed, 2 no report written.

## Known uncertainties for the first run

- **Playwright MCP flags** (`--storage-state`, `--isolated`, `--no-sandbox`) and the version: the version is resolved from npm at run time and printed; pin it in `PLAYWRIGHT_MCP_VERSION` once it works. The browser is installed on first use by the MCP server.
- **Agent turn budget:** 60 turns may be too few for eight scenarios. Raise `TEST_AGENT_MAX_TURNS` if the agent runs out.
- **Portal steps in the prompt** are described in general terms; the agent explores the portal itself. Tighten the prompt after seeing a run.
- **Base image pull** from `ghcr.io` may need a login; the script falls back to building from the checkout (slower).
- **API key exposure:** the key is in the `claude` process on the VM. Use a dedicated, spend-limited key.

## Next steps (not started)

1. First run in the VM, read `evidence.md` and tune the prompt.
2. Turn confirmed findings into deterministic tests in `gateway/test/e2e/`.
3. `.github/workflows/test-agent.yml` (report-only first), with the private-repo findings step and the nightly exploratory run in `infosupport/huddle-security`. Needs an `ANTHROPIC_API_KEY` secret, a `SECURITY_REPO_TOKEN`, and pinned action SHAs.

## Questions still open

1. Is the CI workflow in scope now, or after the local run works? (Needs the private repo and the secrets above.)
2. Should the later nightly exploratory run reuse `run.sh` with a different prompt, or live only in the private repo?
