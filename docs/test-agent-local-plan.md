# Local test agent (runner mirror in a Linux VM)

Status: **local agent works and is verified with fault injection** (2026-11-23). `scripts/test-agent/run.sh`, `scripts/test-agent/fault-injection.sh`, `.github/agent/test-agent.md` and `.github/agent/playwright-mcp.json` exist; see `scripts/test-agent/README.md` for usage. Not built yet: the CI workflow, the private findings step and the nightly exploratory run (see "Next steps").

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

- No Hyper-V Enhanced Session, shared folders or clipboard sharing with the PC. Reach it over SSH without agent or X11 forwarding.
- No credentials that can push to GitHub or reach anything else (a read-only checkout is enough), and no real work login. The agent has the `Read` and `Write` tools on the VM, so the VM, not the container, is what contains it.
- Take a Hyper-V checkpoint of the clean state and restore it after runs you do not trust.
- `run.sh` refuses to run on anything that does not look like a VM (`systemd-detect-virt --vm`).
- Read agent output with `cat -v` or `less`, not by letting a terminal interpret it.

The agent runs on the VM next to the devcontainer, not inside it. Its only shell into the target is `docker exec target-dc`, and its token stays on the VM.

## Choices taken from the PDF

| Question | Answer | Source |
|---|---|---|
| Which scenarios? | All of the fixed list, every run | p. 16-17 table |
| Credentials? | Environment variable on the VM, never inside the target container: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, works on a team plan, typed with `read -rs`) or `ANTHROPIC_API_KEY`. | p. 18, p. 21 ("keep the key on the runner outside the devcontainer") |
| Network? | Open, like the GitHub runner, which sits outside Huddle's firewall | p. 15, p. 18 |
| Where do findings go? | Locally: `findings.md` in the run's output folder, nothing posted. In CI later: private repo via a separate step. | p. 18-19, p. 23 |
| Login of the browser? | The operator token is a session cookie (`huddle_session`). `run.sh` puts it in a Playwright storage-state file, so the agent never sees the token. | `gateway/src/auth.ts` |
| Tool allowlist | `mcp__playwright__*`, `Bash(docker exec target-dc:*)`, `Read`, `Write`. Added: `Bash(docker exec -u root target-dc:*)` (the sudo scenario needs root in the target). `Read(//proc/**)` is denied. `--allowedTools` only pre-approves, it does not limit what exists; the tools are deliberately not restricted further, since an attacker would not be either. | p. 19 |

## What `run.sh` does (mirrors the CI job)

1. Preflight: Linux, in a VM, tools present, a credential set, no leftovers of an earlier run (`--clean` removes them).
2. Install Chromium for the pinned Playwright MCP (`0.0.86`, `--browser chromium --headless --no-sandbox --isolated`).
3. Build `huddle:pr` from `gateway/`; pull `base-devimage` and `base-devimage-vscode` (build from this checkout when the pull fails or `TEST_AGENT_BUILD_BASE=1`).
4. Start Huddle like the `e2e` job in `.github/workflows/test.yml` (internal `devcontainer-net`, random `HUDDLE_OPERATOR_TOKEN`, Docker socket and `/tmp/dc-sockets` mounted, then `docker network connect bridge huddle`). The port is bound to `127.0.0.1` only.
5. Create the target devcontainer `target-dc` through Huddle's API (`POST /api/docker/start`), as `spawnDevcontainer` does in `gateway/test/e2e/helpers.ts`.
6. Run `claude -p` with the prompt, the Playwright MCP config (`--strict-mcp-config`), the allowlist, the pinned model `claude-sonnet-5-5`, `--max-turns 120` and a 45 minute timeout, writing a full transcript to `agent.jsonl`.
7. Warn if the agent ran out of turns or left files besides its output files (kept, never deleted). Print `report.md`; keep `evidence.md`, `findings.md`, `huddle.log` (the network log) and the transcript in the output folder; remove the Huddle stack.

Exit code: 0 no failures, 1 an area failed, 2 no report written.

## Agent prompt rules learned from the first runs

- It runs unattended: never ask, a refused command is simply not allowed, write `evidence.md` and a provisional `report.md` after scenario 1 and update after each area.
- Finish scenarios 1 to 7 before the portal scenario, which takes many browser steps.
- Scenario 7 must show sudo working with the one-time password from the grant response; otherwise it is UNCLEAR.
- Record every console error and 5xx, even from its own malformed requests.
- No helper scripts and no files besides `evidence.md`, `report.md`, `findings.md`.

## Proof the agent can fail: `fault-injection.sh`

Result of the full run on 2026-11-23 (about 5-7 minutes per fault, 17 minutes total):

| Fault | Verdict |
|---|---|
| `baseline` (no change) | OK, no false alarm |
| `privileged` (privileged check off) | DETECTED, "Docker socket" failed |
| `path-traversal` (`..` rejection off) | DETECTED, "Bypass attempts" failed, findings named the right cause |

Caveats: results vary from run to run (depth of the sudo check, whether a 5xx was recorded), so one clean run does not prove a clean boundary; findings are leads for a maintainer, not verified diagnoses (the privileged finding guessed at the cause). Re-run the faults after any change to the prompt, model or setup. More faults can be added to `apply_fault` and `expected_area`.

## Known observations (not acted on)

- `DELETE /api/authz/grants/<container>` with a JSON content-type and an empty body returns 500 (the body parser's "Body cannot be empty" error). Probably should be a 4xx or an accepted empty body. Seen in one run only; check whether the portal's own client sends it.
- The agent reported that the gateway refuses to remove containers it did not create itself ("not created by this container"). May be by design.

## Next steps (not started)

1. Re-run `baseline` and `path-traversal` after the scenario 7 and stray-file changes (commit `ac241a0`) to confirm nothing regressed.
2. Turn confirmed findings into deterministic tests in `gateway/test/e2e/`.
3. `.github/workflows/test-agent.yml` (report-only first), with the private-repo findings step and the nightly exploratory run in `infosupport/huddle-security`. Needs a credential secret, a `SECURITY_REPO_TOKEN`, and pinned action SHAs.

## Questions still open

1. Is the CI workflow in scope now? (Needs the private repo and the secrets above.)
2. Should the later nightly exploratory run reuse `run.sh` with a different prompt, or live only in the private repo?
