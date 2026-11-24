# Test agent in CI

`.github/workflows/test-agent.yml` runs the AI test agent (Huddle PDF part 2) on every pull request to `main`. It builds Huddle from the PR, starts a target devcontainer, and lets the agent attack it through the portal and from inside the container.

| Job | Runs | Output |
|---|---|---|
| `test-agent` | every PR | one PASS / UNCLEAR / failed line per area. Red check when an area failed. Findings are encrypted and uploaded as the `findings` artifact. |
| `report` | every PR | posts the allowed report lines as a PR comment. |
| `report-findings` | only when there are findings | **waits for approval**, then decrypts the findings and files them as a private vulnerability report. |

Details of a failed security check never appear in the PR, the Actions log or an unencrypted artifact. All three are public on a public repository.

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

The reporting GitHub App needs no webhook, the repository permission "Security advisories: Read and write", and is installed on this repository only.

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

Approve within a day. The encrypted findings artifact is kept for 1 day (`retention-days: 1`). After that, `report-findings` fails and the findings are lost. Rejecting also discards them.

### What it does not protect

`CLAUDE_CODE_OAUTH_TOKEN` is a repository secret, because every PR run needs it. Anyone with write access can still read it from a PR. Only the reporting secrets sit behind the approval.

Pull requests from forks receive no secrets at all on `pull_request`, so the agent cannot run on them. This is not solved yet.
