#!/usr/bin/env bash
# Usage: scripts/security-bump.sh <package> <version>
# Manual emergency bump without Renovate (see docs/security-fast-lane.md).
set -euo pipefail
pkg="${1:?usage: security-bump.sh <package> <version>}"
ver="${2:?usage: security-bump.sh <package> <version>}"
# An exact version only: a range or tag ("latest") would leave the fix unpinned and is not a valid branch name.
[[ $ver =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$ ]] || { echo "version must be exact, like 1.2.3" >&2; exit 1; }
branch="security/${pkg//\//-}-${ver}" # scoped names: @fastify/static -> @fastify-static
# Without jq every lockfile check below would fail and look like "package not found".
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"
# Unrelated local changes would otherwise end up in the security PR.
[[ -z "$(git status --porcelain)" ]] || { echo "working tree not clean (incl. untracked files)" >&2; exit 1; }
# An existing branch means an earlier attempt; inspect or delete it yourself instead of overwriting it.
if git show-ref --verify --quiet "refs/heads/${branch}"; then
  echo "branch ${branch} already exists; check it out to continue, or delete it to start over" >&2
  exit 1
fi
# Branch from the latest main, not from whatever is checked out, so the PR contains only this fix.
git fetch origin main

# Find every project whose lockfile on main contains the package (direct or transitive, any nesting level).
dirs=()
for dir in gateway gateway/frontend cli; do
  if git show "origin/main:$dir/package-lock.json" |
    jq -e --arg p "$pkg" 'any(.packages | keys[]; endswith("node_modules/" + $p))' >/dev/null; then
    dirs+=("$dir")
  fi
done
[ ${#dirs[@]} -gt 0 ] || { echo "$pkg not found in any lockfile; nothing to bump" >&2; exit 1; }

git switch --no-track -c "$branch" origin/main

for dir in "${dirs[@]}"; do
  # Override every copy, including nested ones that other dependencies pull in. npm requires the override of a
  # direct dependency to equal its spec, so that spec is pinned to the same version.
  # Trade-off: this also forces copies another dependency wanted at a different major (docs/security-fast-lane.md).
  specs=("overrides[$pkg]=$ver")
  section=$(jq -r --arg p "$pkg" '
    if .dependencies[$p] then "dependencies" elif .devDependencies[$p] then "devDependencies" else empty end
  ' "$dir/package.json")
  [ -z "$section" ] || specs+=("$section[$pkg]=$ver")
  npm --prefix "$dir" pkg set "${specs[@]}"
  npm --prefix "$dir" install
done

# Test every changed project. CI=true keeps `ng test` out of watch mode.
# The docker build compiles gateway and its frontend, so only cli is built on the host.
for dir in "${dirs[@]}"; do
  [ "$dir" != cli ] || npm --prefix "$dir" run build --if-present
  CI=true npm --prefix "$dir" test --if-present
done
[[ " ${dirs[*]} " != *" gateway"* ]] || docker build -t huddle:security-test ./gateway
