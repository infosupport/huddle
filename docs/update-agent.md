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

## What happens per PR

1. The CLI clones the PR branch into `~/.huddle/update-agent/pr-<n>/` and writes the inputs next to it: the PR body (Renovate's release notes) and the failing CI log. The prompt comes from `.github/agent/update-agent.md` on the default branch, never from the PR branch.
2. It starts the devcontainer `update-agent-pr-<n>`, airlocked with three rules: `registry.npmjs.org`, `api.anthropic.com` and `huddle`. Docker actions stay off and no sudo is granted.
3. It registers your Claude credential with the gateway and gives the container only a placeholder. The proxy swaps it for the real credential on `api.anthropic.com`, for this container only.
4. Claude Code runs in the container. Then the CLI itself runs `npm ci`, `npm run build` and `npm test` in `gateway/frontend`, `gateway` and `cli`. If that fails, the agent gets the output and tries again, up to 3 attempts.
5. The CLI commits the change in the container and takes it out as a git bundle. It fetches the bundle into a separate clone it never mounted, so a git hook or config the agent planted cannot run on your machine.
6. A path guard rejects the result if it touches `.github/`, Renovate config, a Dockerfile, `base-devimage*/` or `gateway/src/{auth,tls-ca,socket-proxy,proxy}.ts`. Deleted tests, new `.skip`/`.only` and lost `expect()` calls are flagged in the comment for the reviewer.
7. The CLI pushes the commit (a plain fast-forward push, so it fails if the branch moved) and comments the summary. If the agent did not succeed, it labels the PR `agent-gave-up` and comments what went wrong. Nothing is pushed then.
8. It removes the container, its rules and the placeholder. Use `--keep` to keep the container and folder for inspection; the placeholder is revoked either way.

The container never holds GitHub credentials and cannot reach github.com: every GitHub read and write happens on the host.

## When an install needs another host

Everything outside the three rules is blocked and shows up as a **requested** rule for `update-agent-pr-<n>` in the portal. For example, a native module may want to download a prebuilt binary from GitHub. You can approve it there while the agent runs. A dependency update that suddenly wants a new domain during `npm ci` deserves a look before you approve it.

## How it fits the rest of the pipeline

- **Renovate stops rebasing** a branch once someone else committed to it. That is intended: the fix stays. To start over, tick the rebase checkbox in the PR, which drops the agent's commit.
- **The security review gate** wants a fresh approval after every push, including the agent's.
- **Security-critical packages** still need a human approval, as before.
- **Try again:** remove the `agent-gave-up` label and run the command again.

## Rollout

Start with dev-dependency and minor updates. Track how often the agent gives up: a rising rate means the scope is too wide. Move on to majors (Angular, Fastify) once its fixes are routinely accepted.

## Changing the prompt

The prompt lives in `.github/agent/update-agent.md` and is always read from the default branch. To try a change before it is merged, push it to a branch and run with `HUDDLE_UPDATE_AGENT_PROMPT_REF=<branch> huddle update-agent <pr> --dry-run`.
