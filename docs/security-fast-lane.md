# Security fast lane

Runbook for getting a security fix from advisory to published image quickly.

1. **An advisory comes in** from a GitHub Dependabot alert, a Renovate PR or Aikido.
2. **Trigger Renovate**: tick the run checkbox on the Dependency Dashboard so you don't wait for the 4-hourly run.
3. **Renovate opens a PR** labelled `security`. It never automerges, and CI runs.
4. **Review.** For security-critical packages (`node-forge`, `fastify`, `@fastify/**`, `ws`, `better-sqlite3`) the PR
   also carries `needs-security-review`, and the `security-review-gate` check stays red until a maintainer approves
   the latest commit. Spend about 15 minutes on two questions:
   - Does the vulnerable code path touch our code?
   - Does the fix contain breaking changes?
5. **Merge.** `publish-image.yml` publishes the image.
6. **No upstream fix yet?** Run `scripts/security-bump.sh <package> <version>` to pin a patched version through an
   `overrides` entry (it bumps direct dependencies, adds overrides for transitive ones, then builds, tests and builds
   the image). If no patched version exists, disable the vulnerable feature, for example with a firewall rule.
7. **Dry run.** Do this once and record the time from advisory to published image here.

| Date | Advisory | Alert to PR | PR to merge | Merge to published image | Total |
|---|---|---|---|---|---|
| _not yet measured_ | | | | | |
