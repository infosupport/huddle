# Security triage agent

When a PR is labelled `security`, the triage agent does the reading for the fast-lane reviewer. It reads the advisory and the upstream fix, finds where Huddle uses the affected code, decides whether that code is reachable, and checks the version bump for breaking changes. It posts one comment with its analysis. The reviewer still decides: the agent recommends, and never approves, labels, pushes or merges.

It runs in two places, with the same command and the same safeguards:

- **In CI** (`.github/workflows/triage-agent.yml`): every time a PR gets the `security` label. See [Running it in CI](#running-it-in-ci).
- **On your machine**, on your own Huddle:

```bash
huddle triage-agent            # every open PR labelled security
huddle triage-agent 1234       # only PR #1234
huddle triage-agent 1234 --dry-run   # analyse and print the comment, post nothing
```

## Which PRs

A PR labelled `security`, on a branch in this repository (never a fork), that either:

- Renovate opened (its vulnerability alerts add the `security` label, see `vulnerabilityAlerts` in `.github/renovate.json5`), on a `renovate/*` branch; or
- comes from a `security/*` branch made by `scripts/security-bump.sh` (see [security fast lane](security-fast-lane.md)).

The Renovate settings of the update agent apply here too: `HUDDLE_RENOVATE_AUTHOR` and `HUDDLE_RENOVATE_BRANCH_PREFIX` (see [update agent](update-agent.md)).

## The comment

```markdown
### Security triage: node-forge 1.3.1 → 1.3.2 (GHSA-xxxx-xxxx-xxxx)
**Affected:** no
**Our usage:** gateway/src/tls-ca.ts:L40-L125 `CA + leaf signing only; we never verify certificates with forge`
**Reachable from a devcontainer:** no, `the cert parsing path is not used`
**Breaking changes in the bump:** `none found in the diff`
**Recommendation:** merge (low urgency)
```

File references link to the lines at the PR's head commit. Below the analysis, the comment lists Claude Code's turns and cost and the requests per host the container made, as the update agent's comment does.

- **Recommendation** is one of *merge (low urgency)*, *merge now* or *needs a human deep-dive*.
- **Unclear.** When the agent answers "unclear" for *Affected* or *Reachable*, the recommendation is always *needs a human deep-dive*: do the full manual review from the [security fast lane](security-fast-lane.md). The same goes when the agent wrote no analysis the CLI could check.
- **Re-runs** update the same comment instead of adding one. To re-run, remove and re-add the label, or run the workflow by hand with the PR number. A new push to the PR does not start a run.

## How it stays safe

The advisory text, release notes and upstream commit messages are untrusted input: a crafted advisory could try to steer the agent. So:

- **The CLI writes the comment, not the agent.** The agent writes `/workspace/out/triage.json`: fixed fields, enum values, file paths and line numbers. The CLI checks every field. File paths must exist in the PR. Text fields are length-capped and shown as inline code, so no link, image, HTML or @mention from the agent renders. A file that fails the check becomes "unclear, needs a full manual review".
- **It only comments.** Its GitHub access is the comment and nothing else (the job token has `pull-requests: write` and `contents: read`; a GitHub App, if you use one, gets a token with just those). The container has no GitHub credentials at all.
- **It runs inside Huddle.** The container `triage-agent-pr-<n>` is airlocked and isolated like the update agent's (see [update agent](update-agent.md#what-happens-per-pr)), with the design doc's allowlist: `registry.npmjs.org`, `github.com`, `api.github.com`, `api.osv.dev` and `api.anthropic.com`, plus `huddle` for the audit log. It has no Docker actions and no sudo, and the Claude credential stays behind the token exchange. Anything else shows up as a requested rule for the container in the portal.
- **It installs nothing.** The agent compares the old and new package with `npm pack --ignore-scripts` and `diff`. It never runs `npm install` or `npm ci`, so the bumped package's install scripts never run. Its shell is limited to `curl`, `npm view`, `npm pack`, `tar`, `diff`, read-only `git` and a few file commands. It may write only in `/workspace/out`.
- **The prompt comes from the default branch** (`.github/agent/triage-agent.md`), never from the PR. To try a change before it is merged: `HUDDLE_TRIAGE_AGENT_PROMPT_REF=<branch> huddle triage-agent <pr> --dry-run`.

The host prepares the inputs with its own GitHub access before the container starts: the PR's title and body, `bumps.json` (every package whose version changed in a `package-lock.json` between the merge base and the PR head), and the GitHub advisories for the GHSA and CVE ids named in the PR. The agent looks up the rest itself, unauthenticated, on OSV and GitHub.

## When the analysis must stay private

Sometimes the agent finds that a dependency issue reaches Huddle in a way the advisory does not mention. That is new information an attacker could use, so it follows the private route from the design doc ("Keeping vulnerabilities private"):

- The public comment shows only the headline and *needs a human deep-dive*, with "details sent to maintainers". It includes no usage, reachability or other details.
- With `--out <dir>`, the full analysis goes to `<dir>/pr-<n>-private.md`. Without `--out`, a local run prints it in your terminal. In CI, the workflow encrypts it with age to `SECURITY_REPORT_AGE_RECIPIENT`, the test agent's key, and uploads only the encrypted file. It never prints the analysis, nor the agent's final answer, in the public Actions log.
- A maintainer decrypts it with the `security-report` key, and decides whether it goes to the private security repository as a report. The agent never files an advisory itself.

The update itself usually still merges normally: the PR is the fix.

## Before you run it on your machine

- Huddle is running (`huddle init`).
- You run it from a clone of the repository, with `gh` logged in (`gh auth login`). The comment is posted under your GitHub account.
- A Claude credential is set in your shell: `CLAUDE_CODE_OAUTH_TOKEN` (create one with `claude setup-token`) or `ANTHROPIC_API_KEY`.
- Use `--keep` to keep the container and `~/.huddle/triage-agent/pr-<n>/` for inspection. The placeholder credential is revoked either way. Use `--out <dir>` to write the network log, `pr-<n>-network.json`.
- `HUDDLE_TRIAGE_AGENT_MODEL` pins the Claude model.

## Running it in CI

`.github/workflows/triage-agent.yml` runs on `pull_request_target` when the `security` label is added to a PR from this repository, or by hand with a PR number (and optionally a dry run). `pull_request_target` runs the workflow file from the base branch. The job checks out the **default branch** only (the gateway image, the CLI and the prompt come from there), starts a throwaway Huddle, and runs `huddle triage-agent <pr> --out …`. The PR's code is cloned into the agent's container only, never run on the runner. It uploads the network log, plus an encrypted analysis if there is one, as the artifact `triage-agent-pr-<n>`.

Setup:

- **An environment `triage-agent`**, with deployment branches limited to the default branch, holding the secret `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`; it goes to the gateway, never into the container).
- **The repository variable `SECURITY_REPORT_AGE_RECIPIENT`**, which the test agent already uses (see [test agent in CI](test-agent-ci.md)). Without it, a private analysis is dropped with a warning.
- Optional repository variable `TRIAGE_AGENT_MODEL` to pin the Claude model.

No GitHub App is needed: a comment does not have to start CI, so the job's own `GITHUB_TOKEN` posts it, as `github-actions[bot]`.

Anyone who can add labels (triage access) can start a run, and each run costs Claude usage. The CLI only triages PRs that Renovate opened or that come from a `security/*` branch.
