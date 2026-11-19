# Update agent

When a Renovate PR turns CI red, the update agent tries to fix it. It reads the failing log and the release notes, changes our code, checks the build, and pushes the fix to the Renovate branch with a summary comment. A person still reviews and merges.

```bash
huddle update-agent            # every open Renovate PR with failing CI
huddle update-agent 1234       # only PR #1234
huddle update-agent 1234 --dry-run   # fix and verify, print the diff, push nothing
```

## Before you run it

- Huddle is running (`huddle init`).
- You run it from a clone of the repository, with `gh` logged in (`gh auth login`). The fix is pushed and commented under your GitHub account, and committed under your `git config user.name`/`user.email`.
- A Claude credential is set in your shell: `CLAUDE_CODE_OAUTH_TOKEN` (create one with `claude setup-token`) or `ANTHROPIC_API_KEY`.
- The `agent-gave-up` label exists in the repository (see `.github/labels.yml`).
- Renovate runs as the Mend app. For a self-hosted Renovate, set `HUDDLE_RENOVATE_AUTHOR` to its GitHub login (used to list its PRs) and `HUDDLE_RENOVATE_AUTHORS` to its commit logins or emails, comma-separated (so its commits are not taken for someone else's work). If it uses another `branchPrefix`, set `HUDDLE_RENOVATE_BRANCH_PREFIX` (default `renovate/`).

## What happens per PR

1. The CLI clones the PR branch into `~/.huddle/update-agent/pr-<n>/` and writes the inputs next to it: the PR body (Renovate's release notes) and the failing CI log. The prompt comes from `.github/agent/update-agent.md` on the default branch, never from the PR branch.
2. It starts the devcontainer `update-agent-pr-<n>`, airlocked: it can reach `registry.npmjs.org`, `api.anthropic.com` and `huddle`, plus `better-sqlite3`'s release downloads (only `github.com/WiseLibs/better-sqlite3/releases/download/*` and GitHub's release-asset hosts), which `npm ci` in `gateway` needs for its native binary. Docker actions stay off and no sudo is granted. Claude Code's non-essential traffic, such as telemetry, is turned off.
3. It registers your Claude credential with the gateway and gives the container only a placeholder. The proxy swaps it for the real credential on `api.anthropic.com`, for this container only.
4. Claude Code runs in the container. Then the CLI itself runs `npm ci`, `npm run build` and `npm test` in the projects the PR and the agent changed: `cli`, or `gateway/frontend` and `gateway` together (the gateway build compiles the frontend), or all three when a file outside them changed. CI checks everything after the push. If that fails, the agent gets the output and tries again, up to 3 attempts. If an attempt after a failed check changes nothing, the agent sees no code fix, so the CLI stops there instead of checking the same code again.
5. Before committing, the CLI checks that `.git/config`, `.git/hooks` and `.git/info/attributes` are unchanged since the clone (it reads them as plain files), and commits with hooks disabled. A planted hook or filter could otherwise change the code after it was verified. The CLI then commits the change in the container, with the agent's commit message minus any `Co-authored-by`/`Signed-off-by`-style trailers, and takes it out as a git bundle. It fetches the bundle into a separate clone it never mounted, so a git hook or config the agent planted cannot run on your machine.
6. A path guard rejects the result if it touches `.github/`, Renovate config, a Dockerfile, `base-devimage*/` or the security-core files `gateway/src/{auth,tls-ca,proxy,rules,socket-proxy,docker-actions,sudo-grant,token-exchange,token-exchange-api}.ts`. Deleted tests, new `.skip`/`.only` and lost `expect()` calls are flagged in the comment for the reviewer.
7. The CLI pushes the commit (a plain fast-forward push, so it fails if the branch moved) and comments a summary. The agent's own text goes in a code block, so no links, images, HTML or @mentions render from it, because it wrote it after reading untrusted release notes. If the agent did not succeed, it labels the PR `agent-gave-up` and comments what went wrong. Nothing is pushed then.
8. It removes the container, its rules and the placeholder, also when you stop it with Ctrl+C (press it twice to quit without cleaning up). Use `--keep` to keep the container and folder for inspection; the placeholder is revoked either way. While a kept container exists, the agent skips that PR; remove the container first to run it again.

The container never holds GitHub credentials, and on github.com it can only download `better-sqlite3`'s release binaries: every other GitHub read and write happens on the host.

## When an install needs another host

Everything outside these rules is blocked and shows up as a **requested** rule for `update-agent-pr-<n>` in the portal. For example, a new native module may want to download its prebuilt binary from its own GitHub releases. You can approve it there while the agent runs, and if it is needed every time, add a narrow rule like the `better-sqlite3` one to `AGENT_RULES` in `cli/src/update-agent.ts`. A dependency update that suddenly wants a new domain during `npm ci` deserves a look before you approve it.

## How it fits the rest of the pipeline

- **Renovate stops rebasing** a branch once someone else committed to it. That is intended: the fix stays. To start over, tick the rebase checkbox in the PR, which drops the agent's commit.
- **The security review gate** wants a fresh approval after every push, including the agent's.
- **Security-critical packages** still need a human approval, as before.
- **Try again:** remove the `agent-gave-up` label and run the command again.

## Rollout

Start with dev-dependency and minor updates. Track how often the agent gives up: a rising rate means the scope is too wide. Move on to majors (Angular, Fastify) once its fixes are routinely accepted.

## Changing the prompt

The prompt lives in `.github/agent/update-agent.md` and is always read from the default branch. To try a change before it is merged, push it to a branch and run with `HUDDLE_UPDATE_AGENT_PROMPT_REF=<branch> huddle update-agent <pr> --dry-run`.
