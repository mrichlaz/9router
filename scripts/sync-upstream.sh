#!/usr/bin/env bash
#
# Sync this fork with its upstream parent.
#
#   ./scripts/sync-upstream.sh              # dry run: show what's new upstream
#   ./scripts/sync-upstream.sh --merge      # actually merge into a sync branch
#   ./scripts/sync-upstream.sh --merge --push
#
# Fork chain:
#   decolua/9router       (true upstream)
#     └─ andyvandaric/9router   (parent — carries the hardened patches)
#          └─ mrichlaz/9router  (this repo)
#
# We sync from the PARENT (andyvandaric), because it already contains upstream
# decolua plus the fork-exclusive hardening patches. Merging decolua directly
# would skip those.
#
# The merge lands on a `sync/upstream-<date>` branch, never straight onto
# master — you get to build and test before it touches your release path.

set -euo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/andyvandaric/9router}"
ROOT_REMOTE="${ROOT_REMOTE:-root}"
ROOT_REPO="${ROOT_REPO:-https://github.com/decolua/9router}"

DO_MERGE=false
DO_PUSH=false

for arg in "$@"; do
  case "$arg" in
    --merge) DO_MERGE=true ;;
    --push)  DO_MERGE=true; DO_PUSH=true ;;
    --help|-h)
      sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_bld=$'\033[1m'; c_off=$'\033[0m'
info() { echo "${c_bld}==>${c_off} $*"; }
warn() { echo "${c_yel}warning:${c_off} $*" >&2; }
die()  { echo "${c_red}error:${c_off} $*" >&2; exit 1; }

# --- 0. working tree must be clean: a merge on top of dirty state is unrecoverable
if [ -n "$(git status --porcelain)" ]; then
  die "working tree is dirty. Commit or stash first:
$(git status --short)"
fi

# --- 1. ensure the upstream remotes exist (they live in .git/config, so a
#        fresh clone of the fork will NOT have them)
ensure_remote() {
  local name="$1" url="$2"
  if git remote get-url "$name" >/dev/null 2>&1; then
    return 0
  fi
  info "adding remote '$name' -> $url"
  git remote add "$name" "$url"
  # Make it fetch-only. Pushing to upstream by accident is unrecoverable.
  git remote set-url --push "$name" DISABLED
}
ensure_remote "$UPSTREAM_REMOTE" "$UPSTREAM_REPO"
ensure_remote "$ROOT_REMOTE" "$ROOT_REPO"

# --- 2. fetch
info "fetching origin + $UPSTREAM_REMOTE + $ROOT_REMOTE"
git fetch origin --quiet
git fetch "$UPSTREAM_REMOTE" --quiet
git fetch "$ROOT_REMOTE" --quiet

OURS="$(git rev-parse --abbrev-ref HEAD)"
OUR_HEAD="$(git rev-parse --short HEAD)"
PARENT_HEAD="$(git rev-parse --short "$UPSTREAM_REMOTE/master")"

BEHIND="$(git rev-list --count "HEAD..$UPSTREAM_REMOTE/master")"
AHEAD="$(git rev-list --count "$UPSTREAM_REMOTE/master..HEAD")"

echo
info "branch          : $OURS ($OUR_HEAD)"
info "parent (${UPSTREAM_REMOTE})  : $PARENT_HEAD"
info "true upstream   : $(git rev-parse --short "$ROOT_REMOTE/master")"
echo
info "parent has $BEHIND commit(s) you don't have; you have $AHEAD it doesn't"
echo

if [ "$BEHIND" -eq 0 ]; then
  echo "${c_grn}Already up to date with $UPSTREAM_REMOTE/master.${c_off}"
  echo
  echo "Parent is still at the commit you forked from, so there is nothing to merge."
  echo "Re-run this after the parent cuts a new release."
  exit 0
fi

echo "${c_bld}New upstream commits:${c_off}"
git log --oneline --no-decorate "HEAD..$UPSTREAM_REMOTE/master" | sed 's/^/  /'
echo

# Which upstream files does this fork also modify? Those are the merge-conflict
# candidates — report them before the merge so you know what to expect.
MERGE_BASE="$(git merge-base HEAD "$UPSTREAM_REMOTE/master")"
FORK_FILES="$(git diff --name-only "$MERGE_BASE..HEAD" | sort -u)"
UPSTREAM_FILES="$(git diff --name-only "$MERGE_BASE..$UPSTREAM_REMOTE/master" | sort -u)"
OVERLAP="$(comm -12 <(printf '%s\n' "$FORK_FILES") <(printf '%s\n' "$UPSTREAM_FILES"))"

if [ -n "$OVERLAP" ]; then
  echo "${c_yel}Files both sides changed (likely conflict):${c_off}"
  printf '%s\n' "$OVERLAP" | sed 's/^/  /'
else
  echo "${c_grn}No overlapping files — merge should be clean.${c_off}"
fi
echo

if [ "$DO_MERGE" != true ]; then
  echo "Dry run. To actually merge into a sync branch:"
  echo "  ./scripts/sync-upstream.sh --merge"
  exit 0
fi

# --- 3. merge on a throwaway branch
BRANCH="sync/upstream-$(date +%Y%m%d)"
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  die "branch $BRANCH already exists. Delete it (git branch -D $BRANCH) and retry."
fi

info "creating $BRANCH from $OURS"
git checkout --quiet -b "$BRANCH"

info "merging $UPSTREAM_REMOTE/master"
if git merge --no-edit "$UPSTREAM_REMOTE/master"; then
  echo
  echo "${c_grn}Merged cleanly.${c_off}"
else
  echo
  echo "${c_red}Merge conflicts — resolve these, then commit:${c_off}"
  git diff --name-only --diff-filter=U | sed 's/^/  /'
  echo
  cat <<'TIPS'
How to resolve:
  - Fork-exclusive files (Dockerfile.prebuilt, release.yml, docs/EASYPANEL.md,
    scripts/release.js): keep YOURS. Upstream has no equivalent.
  - README.md / CHANGELOG.md: almost always conflict — upstream rewrites them
    every release. Take the version that keeps your install URLs
    (mrichlaz/9router) and your fork notes.
  - package.json versions: take UPSTREAM's new version; the release workflow
    requires both package.json files to match the tag.
  - Application code under open-sse/ or src/: take BOTH where possible. Your
    hardening patches and upstream fixes are usually independent edits.

After resolving:  git add -A && git commit
TIPS
  exit 1
fi

# --- 4. sanity checks after a clean merge
echo
info "post-merge checks"
ROOT_V="$(node -p "require('./package.json').version" 2>/dev/null || echo '?')"
CLI_V="$(node -p "require('./cli/package.json').version" 2>/dev/null || echo '?')"
echo "  package.json      : $ROOT_V"
echo "  cli/package.json  : $CLI_V"
if [ "$ROOT_V" != "$CLI_V" ]; then
  warn "versions differ — release.yml will refuse to release until they match.
  Run: node scripts/release.js $ROOT_V \"...\" \"...\" (or edit cli/package.json)"
else
  echo "  ${c_grn}versions in lockstep${c_off}"
fi

# Fork-exclusive files must have survived the merge.
MISSING=""
for f in Dockerfile.prebuilt .github/workflows/release.yml scripts/release.js docs/EASYPANEL.md; do
  [ -e "$f" ] || MISSING="$MISSING $f"
done
if [ -n "$MISSING" ]; then
  warn "fork files missing after merge:$MISSING"
else
  echo "  ${c_grn}fork release infrastructure intact${c_off}"
fi

echo
cat <<EOF
${c_bld}Next steps:${c_off}
  1. Build and test:
       npm install && (cd cli && npm install --no-audit --no-fund --ignore-scripts)
       npm run cli:pack
  2. Push the branch and open a PR:
       git push -u origin $BRANCH
  3. Merge to master, then cut a release:
       node scripts/release.js <new-version> "..." "..."
EOF

if [ "$DO_PUSH" = true ]; then
  info "pushing $BRANCH"
  git push -u origin "$BRANCH"
fi
