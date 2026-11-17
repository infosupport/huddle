# Dependency updates

Dependencies are updated by [Renovate](https://docs.renovatebot.com/). The configuration lives in
[`.github/renovate.json5`](../.github/renovate.json5) and is validated on every PR that changes it
(`.github/workflows/renovate-config.yml`).

## Merge policy

| Update | What happens |
|---|---|
| Dev dependencies, patch and minor | Grouped into one PR ("dev tooling (non-major)"). Automerges when CI is green. |
| Runtime dependencies, patch | Automerges when CI is green. |
| Runtime dependencies, minor | One reviewer. |
| Angular (`@angular/**`, `zone.js`, `rxjs`, and the frontend's `typescript`) | One grouped PR, one reviewer. |
| Node image and `@types/node` | One grouped PR ("node runtime"), one reviewer. |
| GitHub Actions, and the Renovate version (`RENOVATE_VERSION`) used by the config validator in `renovate-config.yml` | One grouped PR ("github actions"), one reviewer. Actions are pinned by digest, so updates are digest refreshes; a re-pointed tag or compromised action must not reach the publish workflows unreviewed. |
| Lockfile maintenance | Refreshes `package-lock.json` within the existing ranges; the only way transitive dependencies get updated. One reviewer, never automerges: it cannot wait for the release age, and it also refreshes security-critical packages. |
| Security-critical packages (`node-forge`, `fastify`, `@fastify/**`, `ws`, `better-sqlite3`) | Never automerge. Labelled `needs-security-review`: one reviewer, plus the `security-review-gate` check, which fails until a maintainer (write access or higher) approves the latest commit. The gate also applies to any PR that changes these packages' versions in a `package.json` or `package-lock.json`, with or without the label, so removing the label does not skip it. |
| Major updates | Not opened automatically. Approve them from the Dependency Dashboard. |
| Security advisories | PR labelled `security`, no automerge, no release-age delay. See [security-fast-lane.md](security-fast-lane.md). |

Other rules worth knowing:

- Updates wait 3 days after release (`minimumReleaseAge`) so that hijacked releases are usually pulled before we see them.
  Security fixes skip the wait.
- Regular updates run on Mondays before noon (Europe/Amsterdam). Lockfile maintenance runs on the same schedule.
- The `engines` Node range is never updated by Renovate; it is a product decision.
- When Renovate rebases a `needs-security-review` PR, the head commit changes and the earlier approval no longer
  counts. The reviewer approves again. This is intentional.

## Repository setup

The merge policy above depends on these GitHub settings. A repository admin sets them once.

- **Allow auto-merge** (Settings → General). Renovate then enables GitHub's auto-merge on the PR, and GitHub merges
  it once the required checks pass. Without this setting Renovate still automerges, but merges the branch itself
  after all checks on it are green, on its next run (about every 4 hours).
- **Branch protection on `main`** with these required status checks: `unit`, `audit`, `e2e` and
  `security-review-gate`. GitHub's auto-merge only waits for *required* checks, so with "Allow auto-merge" on and no
  required checks, a PR that Renovate marks for automerge merges as soon as it opens. Without `security-review-gate`
  as a required check, a red gate does not block a merge.
- **Labels** from [`.github/labels.yml`](../.github/labels.yml) exist in the repository, including `security`,
  `dependencies` and `needs-security-review`.
- **Required approvals**: if branch protection requires an approving review, automerge PRs stall, because Renovate
  cannot approve its own PRs. Either leave required approvals off and rely on the policy above, or exempt Renovate.

## Operating Renovate

- **Dependency Dashboard**: a pinned issue titled "Dependency Dashboard". It lists open, pending, rate-limited and
  awaiting-approval updates. Majors sit under "Pending Approval"; tick the checkbox to create the PR.
- **Rebase / retry**: tick the checkbox next to a PR in the dashboard (or the "rebase" box in the PR body) to make
  Renovate rebase it or retry a failed update. Ticking the run checkbox at the top of the dashboard starts a run
  right away instead of waiting for the next one (hosted Renovate runs about every 4 hours).
- **Changing the config**: edit `.github/renovate.json5` in a normal PR. If the config is invalid, Renovate opens a
  `renovate/reconfigure` branch/PR and reports the error. Push fixes to that branch to test the config before it is
  merged.
- **Logs**: the Mend developer portal (developer.mend.io) shows the run logs per repository. Use it when a PR is
  missing or an update does not show up.
- **Disabling a package**: add a `packageRules` entry with `enabled: false` and a `description` that explains why.
  Keep the security-critical rule last in `packageRules`, because the last matching rule wins.
