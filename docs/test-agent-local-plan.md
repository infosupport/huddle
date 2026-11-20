# Local test agent in a Docker-in-Docker arena (plan, not started)

Status: **plan only, nothing implemented yet.**

## Context

The Huddle PDF (Part 2, "Agent 2: Test agent", pp. 16-19) asks for an AI agent that uses a running, throwaway Huddle the way an operator and an attacker would:

- **Browser:** Playwright MCP against the portal on `localhost:3000`, logged in with a per-run operator token.
- **Shell:** `docker exec` into a target devcontainer, to send traffic from inside the boundary (curl, npm install, docker via the proxied socket).
- **Fixed scenarios** (firewall, HTTPS interception, bypass attempts, docker socket, sudo grant, portal), each checked against an expected result.
- **Output:** one pass/fail line per area. Details of a failed security check never appear in public output. Confirmed findings later become deterministic tests in `gateway/test/e2e/`.

In CI it runs on a throwaway GitHub runner. On a developer PC there is no such runner, and running the agent inside the main Huddle is paradoxical: the target Huddle needs a Docker socket to create devcontainers, and the main Huddle exists to keep that away from the agent.

## Decisions

- **Isolation:** a Docker-in-Docker (dind) arena. A privileged `docker:dind` container with its own inner Docker engine, no host socket and no host mounts except an output folder. The throwaway Huddle, the target devcontainer and the agent all run inside it.
- **Later upgrade:** swap the arena for a disposable VM (Canonical Multipass on Hyper-V). Hyper-V is currently **Disabled** on this machine, and Rancher Desktop runs on WSL2, so this needs admin approval and a reboot. The prompt, scenarios and scripts stay the same; only the "start the arena" step changes.
- **Findings stay local.** Nothing is auto-posted to GitHub in the local version.

## What already exists and gets reused

- `.github/workflows/test.yml`, job `e2e`: the recipe for starting a throwaway Huddle. Internal network `devcontainer-net`, random `HUDDLE_OPERATOR_TOKEN`, mounts for `docker.sock` and `/tmp/dc-sockets`, `docker network connect bridge huddle`, wait on `/api/rules`, pull or build the base images. Replay this inside the arena.
- `gateway/test/e2e/helpers.ts`: `spawnDevcontainer`, `execIn`, and the rules, grant and sudo API helpers. They use the `docker` CLI, so they work against the arena via `DOCKER_HOST`, plus `HUDDLE_URL` and `HUDDLE_OPERATOR_TOKEN`.
- `gateway/test/e2e/README.md`: the T1-T11 scenario list, which overlaps the PDF scenario table.
- `.github/agent/update-agent.md`: style reference for agent prompt files.

## Build steps

1. `.github/agent/test-agent.md`: the prompt. Scenario table with expected results, pass/fail/unclear plus the evidence command, writes `findings.md`, never prints bypass details to stdout.
2. `.github/agent/playwright-mcp.json`: headless Playwright MCP with a pinned version.
3. `scripts/test-agent/arena.Dockerfile`: `docker:dind` plus node, `@anthropic-ai/claude-code` and a browser. The repo is copied into the image, not mounted.
4. `scripts/test-agent/run-in-arena.sh`: runs inside the arena and mirrors the CI job. Start `dockerd`, build `huddle:pr`, start it, create the target devcontainer, then run `claude -p` with the prompt, `--mcp-config`, `--allowedTools "mcp__playwright__*,Bash(docker exec target-dc:*),Read,Write"` and `--max-turns 60`.
5. `scripts/test-agent.ps1`: the host entry point. Build the arena image, `docker run --privileged` with no host socket and no mounts except an output folder for `findings.md`, pass a dedicated, spend-limited `ANTHROPIC_API_KEY`, stream the log, then `docker rm -f` the arena so every run starts fresh.
6. Later: `.github/workflows/test-agent.yml` that calls `run-in-arena.sh` directly on the runner (already isolated), a step that files findings in the private `infosupport/huddle-security` repo, and the nightly exploratory run.

## Things to settle while building

- **Browser in an Alpine arena:** Playwright's bundled Chromium needs glibc. Either use Alpine's `chromium` package (and point Playwright MCP at it, with `--no-sandbox` as root) or use a Debian-based dind image.
- **Build context:** a root-level `.dockerignore` would change the existing root-context builds in CI (`-f base-devimage/Dockerfile .`). Use a Dockerfile-specific ignore file (`arena.Dockerfile.dockerignore`) instead.
- **Base images inside the arena:** pulling from `ghcr.io` needs a login, so build `base-devimage` and `base-devimage-vscode` from source inside the arena and tag them with the ghcr names that `helpers.ts` expects. The first run is slow because the arena has no image cache.
- **Run the agent as a non-root user** inside the arena, with access to the inner Docker socket only.
- **API key:** the update agent uses Huddle's token exchange so the real key never enters its container. The arena has no equivalent, so the key is inside the arena. Use a dedicated key with a spend limit.
- **Egress:** the MVP arena has open outbound access. Hardening: allowlist `api.anthropic.com`, `registry.npmjs.org` and `ghcr.io` via iptables or a proxy sidecar.
- **Isolation strength:** privileged dind shares the WSL2 kernel with Rancher Desktop. That is a softer boundary than a VM, and acceptable for the first version.
- **Rancher Desktop:** check that it allows `--privileged` containers.

## Questions to ask the user before starting

Ask these first (use the question tool), so nothing is built on a guess:

1. **API key:** is there a dedicated, spend-limited Anthropic API key for the agent, and how should the script receive it (env var `ANTHROPIC_API_KEY` in the shell, or a local untracked file)?
2. **Privileged containers:** does Rancher Desktop allow `docker run --privileged` on this machine? (Check with a quick `docker run --rm --privileged docker:dind docker --version`, or ask.)
3. **Branch:** start on a new branch (for example `feat/test-agent`) from `main`, or continue on `feat/update-agent`? That branch has unrelated uncommitted changes in `cli/src/update-agent.ts` and `gateway/src/api.ts`.
4. **Entry script language:** `scripts/test-agent.ps1` (matches the repo's `huddle.ps1`) or also a bash version for Linux and macOS developers?
5. **Output folder:** where should `findings.md` and the run log land on the host (for example `scripts/test-agent/out/`, git-ignored)?
6. **Scenario scope for the first run:** all scenarios in the PDF table, or start with a subset (for example firewall and docker socket) to tune the prompt first?
7. **Base images:** build `base-devimage` and `base-devimage-vscode` from source in the arena (slow first run, no login), or log in to `ghcr.io` with a personal token to pull them?
8. **Egress hardening:** accept open outbound access for the first version, or build the allowlist from the start?
9. **CI later:** do the private repo `infosupport/huddle-security`, a `SECURITY_REPO_TOKEN` and an `ANTHROPIC_API_KEY` repo secret exist, or is the CI workflow out of scope for now?
10. **VM later:** if Multipass becomes the goal, can Hyper-V be enabled on this machine (admin rights, reboot, IT policy)?

## Verification

1. Run `scripts/test-agent.ps1` end to end: the arena starts, Huddle answers on `:3000` inside the arena, and the target container runs.
2. Confirm isolation: inside the arena `docker ps` shows only arena containers, the host `docker ps` shows only the arena, and no `/var/run/docker.sock` or host path is mounted.
3. The agent reports a pass/fail line per area. Deliberately break a rule (for example disable a deny) and confirm it is flagged as a fail.
4. The arena is removed after the run, and `findings.md` exists only in the output folder.

## Repo state note

The branch `feat/update-agent` has uncommitted changes in `cli/src/update-agent.ts` and `gateway/src/api.ts`. They are unrelated to this plan. Consider starting the test agent work on its own branch.
