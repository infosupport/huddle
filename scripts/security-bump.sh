#!/usr/bin/env bash
# Usage: scripts/security-bump.sh <package> <version>
# Bumps a package in every project that uses it: directly via npm install,
# transitively via package.json "overrides". Then builds, tests and builds the image.
set -euo pipefail
pkg="${1:?usage: security-bump.sh <package> <version>}"
ver="${2:?usage: security-bump.sh <package> <version>}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"
[[ -z "$(git status --porcelain)" ]] || { echo "working tree not clean (incl. untracked files)" >&2; exit 1; }

git switch -c "security/${pkg//\//-}-${ver}"
changed=()
for dir in gateway gateway/frontend cli; do
  if jq -e --arg p "$pkg" '(.dependencies[$p] // .devDependencies[$p]) != null' "$dir/package.json" >/dev/null; then
    npm --prefix "$dir" install "${pkg}@${ver}" --save-exact
    changed+=("$dir")
  elif npm --prefix "$dir" ls "$pkg" --all >/dev/null 2>&1; then
    tmp="$(mktemp)"
    jq --arg p "$pkg" --arg v "$ver" '.overrides[$p] = $v' "$dir/package.json" > "$tmp" && mv "$tmp" "$dir/package.json"
    npm --prefix "$dir" install
    changed+=("$dir")
  fi
done
[ ${#changed[@]} -gt 0 ] || { echo "$pkg not found in any project" >&2; exit 1; }

for dir in "${changed[@]}"; do
  npm --prefix "$dir" ci
  npm --prefix "$dir" run build --if-present
  npm --prefix "$dir" test --if-present
done
docker build -t huddle:security-test ./gateway

git add -A
git commit -m "fix(deps): bump ${pkg} to ${ver} (security)"
echo "Next: git push -u origin HEAD && gh pr create --label security --label dependencies --label needs-security-review"
