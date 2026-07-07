# Contributing to Huddle

First off — thank you for taking the time to contribute! Huddle is a
community-driven, volunteer-maintained project and every issue, idea, and pull
request helps.

> [!NOTE]
> Huddle is offered **"AS IS"** with **no SLA** and no guaranteed response time.
> Contributions are very welcome, but maintainers review them on a best-effort
> basis. See [`SUPPORT.md`](SUPPORT.md).

By participating in this project you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

---

## Table of Contents

- [Ways to contribute](#ways-to-contribute)
- [Reporting bugs](#reporting-bugs)
- [Requesting features](#requesting-features)
- [Asking questions](#asking-questions)
- [Issue labels](#issue-labels)
- [Development setup](#development-setup)
- [Branching strategy](#branching-strategy)
- [Commit message conventions](#commit-message-conventions)
- [Pull request workflow](#pull-request-workflow)
- [Coding standards](#coding-standards)
- [Code review expectations](#code-review-expectations)
- [License of contributions](#license-of-contributions)

---

## Ways to contribute

- **Report a bug** you ran into.
- **Request a feature** or propose an improvement.
- **Improve documentation** — typos, clarifications, examples, translations.
- **Fix an issue** — look for issues labelled `good first issue` or `help wanted`.
- **Triage** — reproduce reported bugs, add detail, or suggest labels.

You don't need to ask permission to open an issue or a PR. For large changes,
open an issue first so we can align on the approach before you invest time.

## Reporting bugs

Before opening a bug report:

1. **Search existing issues** (open and closed) to avoid duplicates.
2. Make sure you're on the **latest released version**.
3. Try to produce a **minimal, reproducible example**.

Then open a new issue using the **Bug report** template. A good report includes:

- What you expected to happen vs. what actually happened.
- Exact steps to reproduce.
- Version (CLI version, container image tag), runtime (Docker or Podman),
  and OS.
- Relevant logs (with any secrets redacted) and, if applicable, the network log
  entry from the Huddle UI.

For **security vulnerabilities, do not open a public issue** — follow
[`SECURITY.md`](SECURITY.md) instead.

## Requesting features

Open an issue using the **Feature request** template and describe:

- The problem you're trying to solve (the "why", not just the "what").
- Your proposed solution and any alternatives you considered.
- Whether you're willing to work on it yourself.

Feature requests are discussed openly; there is no guarantee a request will be
accepted or implemented.

## Asking questions

For usage questions, use the **Question** issue template or, if enabled, the
repository's **Discussions** tab. Please don't use bug reports for questions.

## Issue labels

We use labels to organize and prioritize work. The most common:

| Label | Meaning |
|-------|---------|
| `bug` | Something isn't working as intended. |
| `enhancement` | A new feature or improvement request. |
| `documentation` | Docs-only changes or gaps. |
| `question` | A usage or clarification question. |
| `good first issue` | A well-scoped starting point for newcomers. |
| `help wanted` | Maintainers would welcome outside help here. |
| `security` | Security-related (usually created from a private advisory). |
| `duplicate` | Already tracked by another issue. |
| `wontfix` | Valid, but intentionally not being addressed. |
| `needs triage` | Not yet reviewed by a maintainer. |

Only maintainers can apply labels; when opening an issue, the template will
apply a sensible default.

## Development setup

Huddle is a monorepo with two main parts: the **gateway** (Fastify API + Angular
UI + proxy) and the **CLI**.

**Prerequisites:** Node.js 20+ (24 LTS recommended), Docker or Podman, and Git.

```bash
# 1. Clone
git clone https://github.com/infosupport/huddle.git
cd huddle

# 2. Install dependencies for gateway + CLI
npm install            # runs install for gateway and cli

# 3. Build
npm run build          # build the gateway (API + frontend)
npm run cli:build      # build the CLI

# 4. Type-check the CLI
npm run cli:typecheck

# 5. Run the gateway locally
npm start
```

Tests:

```bash
npm --prefix gateway test          # gateway unit + e2e tests (vitest)
```

See the [README](README.md) for the full architecture overview and how to run
Huddle end-to-end. See the "Development setup" and "Troubleshooting" sections of
the README for more detail.

## Branching strategy

Huddle uses a **trunk-based** workflow:

- `main` is always releasable. Do not commit directly to `main`.
- Create a **short-lived feature branch** off `main` for each change.
- Name branches descriptively, using a type prefix that matches the change:
  - `feat/<short-description>` — new functionality
  - `fix/<short-description>` — bug fixes
  - `docs/<short-description>` — documentation
  - `chore/<short-description>` — tooling/maintenance
- Open a pull request back into `main`. All changes land via PR.

Versioning is automated with **GitVersion**: every commit on `main` gets a
unique, incrementing patch version. A new **minor/major** release is cut by
pushing a tag (e.g. `git tag v1.1.0 && git push origin v1.1.0`). Only
maintainers push release tags.

## Commit message conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short summary>
```

Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`,
`ci`, `build`.

Examples from this repo:

```
fix(proxy): scrub OAuth-token uit audit-log bij token-exchange
feat(cli): Podman-support voor huddle init
docs: voeg volledige Getting Started toe met token en login stappen
```

Guidelines:

- Use the imperative mood ("add", not "added"/"adds").
- Keep the summary under ~72 characters.
- Reference issues in the body or PR (`Fixes #123`).

## Pull request workflow

1. **Fork** the repo (external contributors) or create a branch (maintainers).
2. Make your change on a feature branch.
3. Ensure it **builds, type-checks, and tests pass** locally.
4. Keep the PR **focused** — one logical change per PR.
5. Fill in the **pull request template** completely.
6. Link the issue your PR addresses (`Fixes #123`).
7. Push and open the PR against `main`.
8. Make sure **CI is green**; address review feedback by pushing new commits.

Draft PRs are welcome for early feedback. Maintainers may squash-merge to keep a
clean history.

## Coding standards

- **Language:** TypeScript for gateway and CLI; Angular (standalone components,
  signals) for the frontend.
- **Formatting:** run [Prettier](https://prettier.io/) before committing
  (`npx prettier --write .` within the relevant package). Match the existing
  style; don't reformat unrelated code.
- **Types:** keep the code type-safe — no new `any` where a real type fits;
  `npm run cli:typecheck` and the gateway build must pass.
- **Tests:** add or update tests for behavioral changes (vitest for the
  gateway). Bug fixes should ideally include a regression test.
- **Security-first:** this is a security tool. Never log secrets, tokens, or
  full request bodies containing credentials. Prefer fail-closed behavior for
  anything gating access.
- **Comments:** explain *why*, not *what*. Remove commented-out code and debug
  logging before opening a PR.

## Code review expectations

- At least one maintainer approval is required before merge.
- Reviews are done on a **best-effort, volunteer basis** — there is no
  guaranteed turnaround time.
- Be responsive to feedback and keep discussions respectful and constructive
  (see the [Code of Conduct](CODE_OF_CONDUCT.md)).
- Reviewers focus on correctness, security, clarity, and test coverage.
- Maintainers may request changes, suggest alternatives, or — with a clear
  rationale — decline a change.

## License of contributions

Huddle is licensed under the **GNU General Public License v3.0** (see
[`LICENSE`](LICENSE)). By submitting a contribution, you agree that your
contribution is licensed under the same GPL-3.0 terms.
