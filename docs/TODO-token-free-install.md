# TODO — Make `huddle` install token-free (public packages)

**Goal:** a new user can run the Getting Started steps in the README
(`npm install -g @infosupport/huddle-cli` + `huddle init`) **without any GitHub
token or registry login**.

**Status:** the README already promises a token-free install. The code side is
done: `cli/package.json` points at npmjs.com and all CLI publishing lives in
`.github/workflows/publish-npm.yml` using **npm trusted publishing** (OIDC — no
npm token secret at all; tasks 2c and 2d below). What remains is manual: make
the ghcr images public (task 1), claim the npm scope (2a), do the first manual
publish, and configure the trusted publisher on npmjs.com (2b). Until 2a/2b are
done, every CLI publish job (including experiment builds) will fail.

---

## Background — why a token is still needed today

| Package | Registry today | Anonymous (token-free) install? |
|---------|----------------|---------------------------------|
| Huddle image (`ghcr.io/infosupport/huddle`) + base-devimages | GitHub Container Registry (ghcr.io) | ✅ **Only if the package visibility is set to Public.** Public ghcr images can be pulled anonymously. |
| CLI (`@infosupport/huddle-cli`) | **GitHub Packages npm** (`npm.pkg.github.com`) | ❌ **No.** GitHub Packages' npm registry requires authentication for *every* install, even for public packages. This is a documented GitHub limitation. |

So the Docker side just needs a visibility flip; the npm side needs a registry
migration to **npmjs.com** (the public default registry).

---

## Task 1 — Make the container images public (ghcr.io)

No code change; this is a GitHub setting.

1. Go to the org packages: `https://github.com/orgs/infosupport/packages`.
2. For each Huddle package — `huddle`, `base-devimage`, `base-devimage-vscode`,
   `base-devimage-intellij`, `base-devimage-rider` — open **Package settings**.
3. Under **Danger Zone → Change visibility**, set to **Public**.
4. Verify from a machine with no Docker login:
   ```bash
   docker logout ghcr.io
   docker pull ghcr.io/infosupport/huddle:latest   # should succeed
   ```

> This also fixes CI on external forks, which currently fails pulling the
> base images (see the open-source-readiness report).

---

## Task 2 — Publish the CLI to public npmjs.com instead of GitHub Packages

### 2a. Reserve the scope/name on npmjs.com
- Create (or claim) the **`infosupport`** org on [npmjs.com](https://www.npmjs.com/),
  or decide on an alternative name (e.g. unscoped `huddle-cli`, if free).
- Scoped packages are private by default on npm, so publishing must use
  `--access public` (see 2c).

### 2b. First manual publish + configure trusted publishing (OIDC, no token)
CI authenticates via **npm trusted publishing**: npmjs.com verifies a
short-lived OIDC credential from the configured GitHub Actions workflow, so no
npm token is stored anywhere.

1. **First publish must be manual** — trusted publishing can only be configured
   on a package that already exists on the registry. From a logged-in machine:
   `cd cli && npm run build && npm publish --access public`.
2. On npmjs.com, open the package → **Settings → Trusted Publisher** and add:
   - Organization or user: `infosupport`
   - Repository: `huddle`
   - Workflow filename: `publish-npm.yml`
   - Environment: leave empty (we don't use one; a mismatch here fails with a
     misleading 404)

Gotchas:
- npm allows **one trusted publisher per package** — which is why all CLI
  publishing (stable + experiment) lives in the single `publish-npm.yml`.
- Trusted publishing requires **npm ≥ 11.5.1**; the workflow uses Node 24 for
  that. npm 10.x (Node 20/22) fails with a 404 that gives no hint.
- `--provenance` requires the GitHub repo to be **public** first.

### 2c. Point the package at npmjs
Edit `cli/package.json` — replace the GitHub Packages registry with npmjs and
force public access:

```jsonc
// remove:
"publishConfig": {
  "registry": "https://npm.pkg.github.com"
}

// with:
"publishConfig": {
  "registry": "https://registry.npmjs.org",
  "access": "public"
}
```

(If you move to an **unscoped** name, `"access": "public"` is optional but
harmless. Also update the `name` field and every `@infosupport/huddle-cli`
reference in the READMEs.)

### 2d. Update the publish workflow — done, see `publish-npm.yml`
All CLI publishing (stable + experiment) is consolidated in
`.github/workflows/publish-npm.yml`, because npm allows only one trusted
publisher per package. The jobs use:

```yaml
    permissions:
      contents: read
      id-token: write          # OIDC for trusted publishing

      - uses: actions/setup-node@v4
        with:
          node-version: 24     # npm >= 11.5.1 required
          registry-url: https://registry.npmjs.org

      - name: Publish
        run: cd cli && npm publish --provenance --access public
        # no NODE_AUTH_TOKEN — auth is the OIDC exchange
```

The GitVersion-based version calculation stays as-is — it still sets
`package.json` to the published version before `npm publish`, so
`huddle --version` keeps matching the registry.

### 2e. Verify
From a clean machine / container with **no** `.npmrc` and no auth:
```bash
npm view @infosupport/huddle-cli version     # resolves from npmjs
npm install -g @infosupport/huddle-cli       # succeeds without a token
huddle --version                             # matches the published version
```

---

## Definition of done
- [ ] All Huddle ghcr images set to **Public**; anonymous `docker pull` works.
- [x] `publishConfig` and publish workflows point at **npmjs.com**, publishing
      via trusted publishing / OIDC from `publish-npm.yml` (2c + 2d).
- [ ] First manual publish of `@infosupport/huddle-cli` to **npmjs.com** done.
- [ ] Trusted publisher configured on npmjs.com (repo `infosupport/huddle`,
      workflow `publish-npm.yml`); publish workflow green.
- [ ] Clean-machine `npm install -g @infosupport/huddle-cli` works with no token.
- [ ] README / cli/README install instructions verified end-to-end.

## Alternative (not recommended)
Keep the CLI on GitHub Packages. Then the README **must** re-add the
`read:packages` token + `.npmrc` steps, because token-free npm install is not
possible there. This contradicts the current "no token needed" wording.
