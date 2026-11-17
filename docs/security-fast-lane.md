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
   `overrides` entry. It needs `jq` and a clean working tree. It finds every project whose lockfile contains the
   package, creates a `security/<package>-<version>` branch (`/` in scoped names becomes `-`), bumps direct
   dependencies, adds an override so nested copies are patched too, builds and tests every changed project, and builds
   the image. It stops if the package is in no lockfile, or if the branch already exists (an earlier attempt: check it
   out to continue, or delete it to start over). Then commit, and open a PR
   labelled `security` (plus `needs-security-review` for security-critical packages). If no patched version exists,
   disable the vulnerable feature, for example with a firewall rule.

   **Trade-off:** the override forces *every* copy of the package to the new version, including copies that another
   dependency asked for at a different major version. That dependency may then break. The script's builds, tests and
   docker build are the check for this; `cli` has no test suite, so there only its build (type check) runs. In the PR,
   mention which dependencies were forced onto a new major.
   Remove the override once the upstream dependencies ship the fix themselves.
7. **Dry run.** Do this once and record the time from advisory to published image here.

| Date | Advisory | Alert to PR | PR to merge | Merge to published image | Total |
|---|---|---|---|---|---|
| _not yet measured_ | | | | | |
