# Test agent in CI

`.github/workflows/test-agent.yml` runs the AI test agent (Huddle PDF part 2) on every pull request. It builds Huddle from the PR, starts a target devcontainer, and lets the agent attack it through the portal and from inside the container.

| Job | Runs | Output |
|---|---|---|
| `test-agent` | every PR | one PASS / UNCLEAR / failed line per area. Green only when all six areas PASS: a failed area, or an UNCLEAR one (not tested properly), turns it red. Findings (failed or UNCLEAR security areas) are encrypted and uploaded as the `findings` artifact. |
| `report` | every PR | posts the allowed report lines as a PR comment. |
| `report-findings` | only when there are findings | **waits for approval**, then decrypts the findings and files them as a private vulnerability report. |

Details of a failed security check never appear in the PR, the Actions log or an unencrypted artifact. All three are public on a public repository.

Other safeguards in the workflow:

- **The judge comes from the base branch.** The agent's prompt, its MCP config and its pinned tools (`.github/agent/`) are taken from the PR's base branch, so a PR cannot edit them to pass its own test. A PR that changes `.github/agent/` is still tested with the old version. The new version takes effect once it is merged. (If the base branch has no `.github/agent/` yet, the run uses the PR's copy and shows a warning.) The files are installed after the PR's own build steps, so a changed build script cannot overwrite them. This guards against simple tampering, not against a determined attacker: the PR's code runs on the same runner (the Huddle container even gets the Docker socket), and someone with write access can edit the workflow itself. Requiring review of `.github/` changes, for example with CODEOWNERS, closes that.
- **Pinned tools.** Actions are pinned by commit SHA. The Playwright MCP server and its dependencies are locked by `.github/agent/package-lock.json`, so Renovate can update them like any other dependency. `npm ci` runs with `--ignore-scripts`.
- **The allowlist is the boundary.** The agent runs in permission mode `default`: tools and commands outside its allowlist are denied, because nobody can approve them in CI. Chained commands are checked one by one.
- **The agent only reads and writes what it needs.** It may read its prompt, `gateway/test/e2e/` and its own output files, and write only `evidence.md`, `report.md` and `findings.md`. Before it starts, symlinks in the checkout and any `report.md` committed by the PR are removed, so a PR can't point the agent at the login file or supply its own report. Its shell access is `docker exec` into the target container only.
- **The operator token stays out of reach.** The browser's login file is written to `$RUNNER_TEMP`, outside the working directory, and reading it is explicitly denied. The agent works as the operator through the logged-in browser, but never reads the token itself.
- **One run per PR.** A new push cancels the run in progress, and every run updates the same PR comment.
- **Least-privilege tokens.** The reporting App's token is limited to this repository and to the App's single permission (see Setup).

## Private reports: FAILED versus UNCLEAR

Both kinds go to the maintainers as a private report, because even the details of an incomplete test can hint at a weak spot. The title tells them apart:

| Title | Meaning | Severity |
|---|---|---|
| `Test agent, run <id> \| FAILED: Docker socket` | a check failed: a possible vulnerability | high (adjust after triage) |
| `Test agent, run <id> \| UNCLEAR: Firewall, HTTPS interception` | not verified, for example because a command was blocked | not set |

A report can have both labels. In the description each area starts with `## FAILED: <Area>` or `## UNCLEAR: <Area>`.

Every report starts in **Triage** (Security > Advisories). A maintainer accepts it as a draft advisory, or closes it: an UNCLEAR report is usually closed after a re-run passes.

GitHub only notifies repository admins and security managers who **watch** the repository with "All Activity", or with "Custom" > "Security alerts". Watching is off by default, and on forks too.

## Setup

| What | Where | Value |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | repository secret | output of `claude setup-token` |
| `SECURITY_REPORT_AGE_RECIPIENT` | repository variable | public key (`age1…`) from `age-keygen` |
| `SECURITY_REPORT_APP_CLIENT_ID` | repository variable | Client ID of the reporting GitHub App |
| `SECURITY_REPORT_AGE_IDENTITY` | secret in the `security-report` environment | the private key file from `age-keygen` |
| `SECURITY_REPORT_APP_PRIVATE_KEY` | secret in the `security-report` environment | the App's `.pem` private key |
| `security-report` environment | Settings > Environments | **required reviewers**, see below |
| Private vulnerability reporting | Settings > Security | enabled |

The reporting GitHub App needs no webhook and is installed on this repository only. Give it the repository permission "Security advisories: Read and write" and nothing else. The workflow's token gets all of the App's permissions.

## The `security-report` environment needs required reviewers

### Why

A `pull_request` run uses the workflow file **from the PR's own branch**. Anyone who can push a branch to this repository can open a PR that changes `test-agent.yml` to print or send away any secret the run receives. The workflow cannot defend against that, because the attacker writes the workflow.

The two reporting secrets are therefore not repository secrets but secrets of the `security-report` environment. GitHub only releases an environment's secrets to a job after one of its required reviewers approves that job. The reviewer, not the PR, decides whether the secrets are used.

Without required reviewers the environment is only a name: its secrets are released to every run, exactly like repository secrets.

### What happens without a reviewer, and the risks

The workflow keeps working and reports are filed without anyone clicking anything. Nobody notices that the protection is gone. Anyone with write access can then, from a PR:

- **read the age private key**, and decrypt every `findings` artifact still stored, including those of other PRs. These artifacts can be downloaded by anyone on a public repository, so the encryption is the only thing keeping vulnerability details private.
- **use the reporting App's private key**, with the App's "Security advisories" permission. That covers filing fake or spam reports, and reading the repository's private security advisories, which list every reported, unfixed vulnerability.

In short: an unfixed vulnerability in Huddle can leak before it is fixed, through one malicious or compromised account with write access.

### Who should be the reviewer

- **An organization repository (`infosupport/huddle`):** the team that handles security reports, for example the maintainers team. Any one member's approval is enough, and nothing has to change when people join or leave the team.
- **A personal fork:** teams do not exist there, so it is the repository owner.

Reviewers must be people who may see vulnerability details anyway, since approving releases them into a run. Leave "Prevent self-review" off so a maintainer can approve findings on their own PR. Up to six users or teams can be listed.

### What it costs

Only runs with findings wait, which should be rare. PRs without findings never ask for approval. The PR comment and the red check appear without approval, because the `report` job is separate and uses no environment.

### How to approve

When a run has findings, the run page shows "Review deployments" for `security-report`. Before approving, check that the PR does not change `.github/workflows/` or `.github/agent/`. If it does, read those changes first: they decide what the secrets are used for. Then approve, and the private report appears under Security > Advisories.

Approve within a day. The encrypted findings artifact is kept for 1 day (`retention-days: 1`). After that, `report-findings` fails and the findings are lost. Rejecting also discards them, and so does a new push to the PR, which cancels the waiting run. The new run reports again if the problem is still there.

### What it does not protect

`CLAUDE_CODE_OAUTH_TOKEN` is a repository secret, because every PR run needs it. Anyone with write access can still read it from a PR. Only the reporting secrets sit behind the approval.

Pull requests from forks receive no secrets at all on `pull_request`, so the agent cannot run on them. This is not solved yet.

## Debugging a run

Every run uploads a `debug` artifact, kept for 7 days. It holds the agent's full transcript (every tool call and result), plus its raw `report.md` and `evidence.md`. It is encrypted with the same age key as the findings, because it can contain bypass details. To read it, use the private key (`SECURITY_REPORT_AGE_IDENTITY`):

```bash
gh run download <run-id> -n debug
age -d -i security-report.agekey debug.tar.gz.age | tar -xz
```

Read the transcript with `less` or `jq`, not by printing it raw to a terminal: it is text produced by an agent attacking a container.

## Evidence that it works

A green report only means something if the agent turns red on a real bug. Each fault below was planted in `gateway/src` and run once:

| Fault | Where | Result |
|---|---|---|
| none (baseline) | VM (`fault-injection.sh`) and CI (`feat/test-agent` PR on the fork) | all areas PASS, no false alarm |
| privileged-container check off | VM and CI (`demo/test-agent-fault-privileged` PR on the fork) | "Docker socket" failed. The private report named the right cause. |
| `..` rejection off in `normalizePathname` | VM only | "Bypass attempts" failed. The findings named the right cause. |

A CI run takes about 10 minutes, of which the agent itself takes about 6 to 7 minutes and 65 to 80 turns.

Caveats:

- Results vary from run to run: how deep the sudo check goes, and whether a 5xx was recorded. One clean run does not prove a clean boundary.
- Findings are leads for a maintainer, not verified diagnoses.
- Re-run the faults (`scripts/test-agent/fault-injection.sh`, or a demo PR) after any change to the prompt, the model or the setup.

## Known observations (not acted on)

- `DELETE /api/authz/grants/<container>` with a JSON content-type and an empty body returns 500 (the body parser's "Body cannot be empty"). Probably should be a 4xx or an accepted empty body. Seen in one VM run.
- The gateway refuses to remove containers it did not create itself ("not created by this container"). May be by design.
- In CI, Claude Code ran in auto mode, where a safety classifier judges every command. It blocked a POST with `secretbody=…`, and later `docker run --privileged`, which left those areas UNCLEAR (the second time hiding a planted bug). The agent now runs with `--permission-mode default`, so only the tool allowlist decides. The prompt also asks for neutral test data.
- Two CI runs ended normally without writing `report.md`. The cause is unknown. The `debug` artifact now keeps the transcript, so the next time it can be traced.

## Open work

From the PDF, not built yet:

1. **Report-only period, then a required check.** Run it on PRs for about two weeks to measure the false-alarm rate and the cost, then make it a required check in branch protection.
2. **Nightly exploratory run.** The agent gets a budget (for example 30 minutes) to try to break the boundary freely. It runs in the private security repository, never in the public one. The PDF plans this once the scenario run is stable.
3. **Findings become tests.** Every confirmed finding becomes a deterministic test in `gateway/test/e2e/`. A security finding gets its test in the private fix branch, together with the fix.

Also open: pull requests from forks (see above). The workflow also runs on every PR, while the PDF only asks for dependency PRs, so limiting the trigger would save cost.
