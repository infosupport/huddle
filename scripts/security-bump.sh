#!/usr/bin/env bash
# Usage: scripts/security-bump.sh <package> <version>
# Manual emergency bump without Renovate (see docs/security-fast-lane.md).
set -euo pipefail
pkg="${1:?usage: security-bump.sh <package> <version>}"
ver="${2:?usage: security-bump.sh <package> <version>}"
branch="security/${pkg//\//-}-${ver}" # scoped names: @fastify/static -> @fastify-static
# Without jq every lockfile check below would fail and look like "package not found".
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"
# Unrelated local changes would otherwise end up in the security PR.
[[ -z "$(git status --porcelain)" ]] || { echo "working tree not clean (incl. untracked files)" >&2; exit 1; }

# Find every project whose lockfile contains the package (direct or transitive, any nesting level).
dirs=()
for dir in gateway gateway/frontend cli; do
  if jq -e --arg p "$pkg" 'any(.packages | keys[]; endswith("node_modules/" + $p))' "$dir/package-lock.json" >/dev/null; then
    dirs+=("$dir")
  fi
done
[ ${#dirs[@]} -gt 0 ] || { echo "$pkg not found in any lockfile; nothing to bump" >&2; exit 1; }

# An existing branch means an earlier attempt; inspect or delete it yourself instead of overwriting it.
if git show-ref --verify --quiet "refs/heads/${branch}"; then
  echo "branch ${branch} already exists; check it out to continue, or delete it to start over" >&2
  exit 1
fi
git switch -c "$branch"

for dir in "${dirs[@]}"; do
  if jq -e --arg p "$pkg" '.dependencies[$p] // .devDependencies[$p]' "$dir/package.json" >/dev/null; then
    npm --prefix "$dir" install "${pkg}@${ver}" --save-exact
  fi
  # Override every copy, including nested ones that other dependencies pull in.
  # For a direct dependency this matches the exact version installed above, which npm requires.
  # Trade-off: this also forces copies another dependency wanted at a different major (docs/security-fast-lane.md).
  jq --arg p "$pkg" --arg v "$ver" '.overrides[$p]=$v' "$dir/package.json" > tmp && mv tmp "$dir/package.json"
  npm --prefix "$dir" install
done

# Build and test every project that changed. CI=true keeps `ng test` out of watch mode.
# Gateway is built by the docker build below (which also builds the frontend), so only its tests run here.
for dir in "${dirs[@]}"; do
  [ "$dir" = gateway ] || CI=true npm --prefix "$dir" run build --if-present
  CI=true npm --prefix "$dir" test --if-present
done
docker build -t huddle:security-test ./gateway
