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
| GitHub Actions, version updates | Grouped, automerge when CI is green. |
| GitHub Actions, digest pins and refreshes | One reviewer. A re-pointed tag or compromised action must not reach the publish workflows unreviewed. |
| Security-critical packages (`node-forge`, `fastify`, `@fastify/**`, `ws`, `better-sqlite3`) | Never automerge. Labelled `needs-security-review`: one reviewer, plus the `security-review-gate` check, which fails until a maintainer approves the latest commit. |
| Major updates | Not opened automatically. Approve them from the Dependency Dashboard. |
| Security advisories | PR labelled `security`, no automerge, no release-age delay. See [security-fast-lane.md](security-fast-lane.md). |

Other rules worth knowing:

- Updates wait 3 days after release (`minimumReleaseAge`) so that hijacked releases are usually pulled before we see them.
  Security fixes skip the wait.
- Regular updates run on Mondays before noon (Europe/Amsterdam). Lockfile maintenance runs on the same schedule.
- The `engines` Node range is never updated by Renovate; it is a product decision.
- When Renovate rebases a `needs-security-review` PR, the head commit changes and the earlier approval no longer
  counts. The reviewer approves again. This is intentional.

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
