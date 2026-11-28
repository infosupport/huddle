# Update agent

When a Renovate PR turns CI red, the update agent tries to fix it. It reads the failing log and the release notes, changes our code, checks the build, and pushes the fix to the Renovate branch with a summary comment. A person still reviews and merges.

It runs in two places, with the same command and the same safeguards:

- **In CI** (`.github/workflows/update-agent.yml`): every time the `Test` workflow fails on a Renovate PR. See [Running it in CI](#running-it-in-ci).
- **On your machine**, on your own Huddle:

```bash
huddle update-agent            # every open Renovate PR with failing CI
huddle update-agent 1234       # only PR #1234
huddle update-agent 1234 --dry-run   # fix and verify, print the diff, push nothing
huddle update-agent --skip-majors    # leave PRs labelled `major` alone
```

"Failing CI" means a failed job of the `Test` workflow (set `HUDDLE_UPDATE_AGENT_CI_WORKFLOWS` to a comma-separated list for others). Other red checks are not a build the agent can fix: the security review gate waits for a person, and a scanner or the test agent reports a finding.

## Before you run it on your machine

- Huddle is running (`huddle init`).
- You run it from a clone of the repository, with `gh` logged in (`gh auth login`). The fix is pushed and commented under your GitHub account, and committed under your `git config user.name`/`user.email`.
- A Claude credential is set in your shell: `CLAUDE_CODE_OAUTH_TOKEN` (create one with `claude setup-token`) or `ANTHROPIC_API_KEY`.
- The `agent-gave-up` label exists in the repository (see `.github/labels.yml`).
- Renovate runs as the Mend app. For a self-hosted Renovate, set `HUDDLE_RENOVATE_AUTHOR` to its GitHub login (only PRs it opened are worked on, also when you name a PR) and `HUDDLE_RENOVATE_AUTHORS` to its commit logins or emails, comma-separated (so its commits are not taken for someone else's work). If it uses another `branchPrefix`, set `HUDDLE_RENOVATE_BRANCH_PREFIX` (default `renovate/`).

## What happens per PR

1. The CLI clones the PR branch into `~/.huddle/update-agent/pr-<n>/` and writes the inputs next to it: the PR body (Renovate's release notes) and the failing CI log. The prompt comes from `.github/agent/update-agent.md` on the default branch, never from the PR branch.
2. It starts the devcontainer `update-agent-pr-<n>`, airlocked: it can reach `registry.npmjs.org`, `api.anthropic.com` and `huddle`, plus `better-sqlite3`'s release downloads (only `github.com/WiseLibs/better-sqlite3/releases/download/*` and GitHub's release-asset hosts), which `npm ci` in `gateway` needs for its native binary. It starts isolated: none of the folder mappings from the portal are mounted, and any Docker grant, Docker action or host port that was ever given to a container with this name is cleared first. Its sudo account starts locked, like every new container's. Claude Code's non-essential traffic, such as telemetry, is turned off.
3. It registers your Claude credential with the gateway and gives the container only a placeholder. The proxy swaps it for the real credential on `api.anthropic.com`, for this container only.
4. Claude Code runs in the container. Then the CLI itself runs `npm ci`, `npm run build` and `npm test` in the projects the PR and the agent changed: `cli`, or `gateway/frontend` and `gateway` together (the gateway build compiles the frontend), or all three when a file outside them changed. CI checks everything after the push. If that fails, the agent gets the output and tries again, up to 3 attempts. An attempt that changes nothing is the agent's answer: it sees no code fix (for example, another package's peer range does not allow the new version yet). The CLI then stops and posts the agent's explanation, instead of running the same attempt again.
5. Before committing, the CLI stops every process the agent left running and checks, as root in the container, that `.git/config`, `.git/hooks` and `.git/info/attributes` are unchanged since the start, and that no `.git/commondir` was added. It commits with hooks disabled, and with `GIT_DIR` and `GIT_COMMON_DIR` set to that checked `.git`, so git cannot take its config or attributes from anywhere else. A planted hook or filter could otherwise change the code after it was verified. The CLI then commits the change in the container, with the agent's commit message minus any `Co-authored-by`/`Signed-off-by`-style trailers, and copies it out as a git bundle with `docker cp`. It fetches the bundle into a separate clone it never mounted, so a git hook or config the agent planted cannot run on your machine. Once the container runs, the CLI never reads or writes the mounted folder by path: any file there could be a symlink to a file on your machine. It reads the agent's commit message and summary through the container instead.
6. A path guard rejects the result if it touches `.github/`, Renovate config, a Dockerfile, `base-devimage*/` or the security-core files `gateway/src/{auth,tls-ca,proxy,rules,socket-proxy,docker-actions,sudo-grant,token-exchange,token-exchange-api}.ts`. Deleted tests, new `.skip`/`.only` and lost `expect()` calls are flagged in the comment for the reviewer.
7. The CLI pushes the commit (a plain fast-forward push, so it fails if the branch moved) and comments a summary. The agent's own text goes in a code block, so no links, images, HTML or @mentions render from it, because it wrote it after reading untrusted release notes. The comment also lists Claude Code's turns and cost, and the requests per host the container made, blocked ones included. With `--out <dir>` the CLI also writes the full network log (host, method, path, status; no headers or bodies, plus Huddle's own events for the container) to `<dir>/pr-<n>-network.json`. If the agent did not succeed, it labels the PR `agent-gave-up` and comments why, with the agent's own explanation and the end of the last check's output. Nothing is pushed then.
   The commit ends with a `Huddle-Update-Agent:` trailer. The agent never builds on its own pushed fix, which would lift the limit of 3 attempts: if CI still fails on that commit, the next run labels the PR `agent-gave-up` instead.
8. It removes the container, its rules and the placeholder, and the PR's folder (the files the agent wrote are deleted as root inside the container first, since on Linux they belong to the container's user), also when you stop it with Ctrl+C (press it twice to quit without cleaning up). Use `--keep` to keep the container and folder for inspection; the placeholder is revoked either way. While a kept container exists, the agent skips that PR; remove the container first to run it again.

The container never holds GitHub credentials, and on github.com it can only download `better-sqlite3`'s release binaries: every other GitHub read and write happens on the host.

## When an install needs another host

Everything outside these rules is blocked and shows up as a **requested** rule for `update-agent-pr-<n>` in the portal. For example, a new native module may want to download its prebuilt binary from its own GitHub releases. You can approve it there while the agent runs, and if it is needed every time, add a narrow rule like the `better-sqlite3` one to `AGENT_RULES` in `cli/src/update-agent.ts`. A dependency update that suddenly wants a new domain during `npm ci` deserves a look before you approve it.

## How it fits the rest of the pipeline

- **Renovate stops rebasing** a branch once someone else committed to it. That is intended: the fix stays. To start over, tick the rebase checkbox in the PR, which drops the agent's commit.
- **The security review gate** wants a fresh approval after every push, including the agent's.
- **Security-critical packages** still need a human approval, as before.
- **Try again:** remove the `agent-gave-up` label and run the command again (in CI: run the workflow by hand with the PR number). If the agent's own fix is on the branch, tick the rebase checkbox first.

## Running it in CI

`.github/workflows/update-agent.yml` starts when the `Test` workflow completes with a failure on a `renovate/*` branch of this repository, or by hand with a PR number (and optionally a dry run). On the GitHub runner it:

1. checks out the **default branch**, never the PR: the Huddle gateway image, the CLI and the prompt all come from there. `workflow_run` also runs the workflow file itself from the default branch, so a PR cannot change what judges it;
2. builds and starts a throwaway Huddle, like the test agent does, and pulls the devcontainer image;
3. runs `huddle update-agent <pr> --out …` as above, and uploads the network log as the artifact `update-agent-network-pr-<n>`.

So the agent runs behind Huddle's firewall in CI too, with the Claude credential behind the token exchange. The design doc's CI fallback (Claude on a bare runner with an API key) had neither.

Setup:

- **A GitHub App** for the pushes and comments. A push with the workflow's own `GITHUB_TOKEN` does not start CI again, so the fix would never be tested. Give the App the repository permissions *Contents: write*, *Pull requests: write*, *Issues: write* and *Actions: read* (failing job logs), and install it on this repository only. Do not give it *Workflows*: GitHub then refuses any push that edits `.github/workflows`, on top of the path guard. A token cannot be limited to `renovate/*` branches, so keep `main` protected; the CLI only ever pushes to the PR's own `renovate/*` branch.
- **An environment `update-agent`**, with deployment branches limited to the default branch, so a workflow on another branch cannot read its secrets. In it:
  - secret `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`; it goes to the gateway, never into the container),
  - secret `UPDATE_AGENT_APP_PRIVATE_KEY` and variable `UPDATE_AGENT_APP_CLIENT_ID` for the App.
- Optional repository variables: `UPDATE_AGENT_MAJORS` = `true` to include major updates (see [Rollout](#rollout)), and `UPDATE_AGENT_MODEL` to pin the Claude model.

The CLI mints the App's installation tokens itself, from `HUDDLE_GITHUB_APP_CLIENT_ID` and `HUDDLE_GITHUB_APP_PRIVATE_KEY`, scoped to this repository and the permissions above. A token lives one hour and an agent run can take longer, so it renews the token before it talks to GitHub again. Commits are authored by the App's bot account, and the comments link to the workflow run instead of naming a person.

The Actions log of this public repository shows the agent's final answer per attempt, not its full transcript.

## Rollout

Start with dev-dependency and minor updates. In CI the workflow passes `--skip-majors` until the variable `UPDATE_AGENT_MAJORS` is `true`. It skips PRs labelled `major`, so Renovate's rule for major updates in `.github/renovate.json5` needs `addLabels: ['major']`. Track how often the agent gives up: a rising rate means the scope is too wide. Move on to majors (Angular, Fastify) once its fixes are routinely accepted.

## Changing the prompt

The prompt lives in `.github/agent/update-agent.md` and is always read from the default branch, also in CI. To try a change before it is merged, push it to a branch and run with `HUDDLE_UPDATE_AGENT_PROMPT_REF=<branch> huddle update-agent <pr> --dry-run`.
