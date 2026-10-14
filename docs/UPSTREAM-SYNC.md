# Keeping this fork aligned with upstream

This repo is a fork. Understanding the chain is the whole game:

```
decolua/9router            ← true upstream (not a fork)
    │  ships the real features, bumps versions
    ▼
andyvandaric/9router       ← your parent (fork of decolua)
    │  adds "hardened fork" patches + its own README
    ▼
mrichlaz/9router           ← YOU (fork of andyvandaric)
       adds release automation + EasyPanel/Docker packaging
```

**Sync from the parent (`andyvandaric`), not from `decolua`.** The parent already
contains upstream `decolua` *plus* the hardening patches. Merging `decolua`
directly would silently drop those patches.

---

## What actually happens when upstream updates

Nothing automatic. A fork is a **point-in-time copy**, not a subscription. When
the parent pushes new commits, your repo does not change. You pull them in when
you choose to run a merge.

Concretely, when the parent releases `v0.6.0`:

1. **Your repo keeps working.** It stays on the code you have. No breakage, no
   downtime. Your released image and tarball are unaffected.
2. **You fall behind on features/fixes.** New providers, bug fixes, and catalog
   updates from upstream simply aren't in your build until you merge.
3. **`latest` doesn't move.** Your `ghcr.io/mrichlaz/9router:latest` keeps
   pointing at your last release until *you* tag a new one.

So there's no emergency. Sync on your schedule.

---

## The sync flow

A helper script automates it: `scripts/sync-upstream.sh`.

### 1. Check what's new (safe, changes nothing)

```bash
./scripts/sync-upstream.sh
```

Prints:
- how many commits the parent has that you don't
- the commit list
- **which files both sides changed** → your conflict candidates, before you merge

### 2. Merge into a throwaway branch

```bash
./scripts/sync-upstream.sh --merge
```

This creates `sync/upstream-<date>` and merges the parent into it. **It never
touches `master`** — you get to build and test first. The script also runs
post-merge checks (version lockstep, fork files still present).

### 3. Resolve conflicts, then test

```bash
# resolve, then:
git add -A && git commit

npm install
(cd cli && npm install --no-audit --no-fund --ignore-scripts)
npm run cli:pack          # proves the prebuilt package still builds
```

### 4. Land it and release

```bash
git push -u origin sync/upstream-<date>   # open a PR
# after merging to master:
node scripts/release.js 0.6.0 "Upstream sync" "Merged upstream v0.6.0"
```

---

## Conflict resolution rules

Merge conflicts are **normal and expected**. They concentrate in a predictable
set of files:

| File(s) | What to do |
| --- | --- |
| `Dockerfile.prebuilt`, `.github/workflows/release.yml`, `scripts/release.js`, `docs/EASYPANEL.md` | **Keep yours.** Upstream has no equivalent; these are fork-exclusive. |
| `README.md`, `README.zh-CN.md` | **Almost always conflicts** — upstream rewrites them every release. Keep your version (install URLs pointing at `mrichlaz/9router`, fork notes). |
| `CHANGELOG.md` | Conflicts every release. Keep both sections; newest version on top. |
| `package.json`, `cli/package.json` | **Take upstream's new version.** `release.yml` refuses to release unless both match the tag. |
| `open-sse/**`, `src/**` | **Take both.** Your hardening patches and upstream's fixes are usually independent edits in the same file — read carefully, keep both. |
| `.github/workflows/docker-publish.yml` | Keep the manual-only trigger (the fork guard that prevents a GHCR tag race). |

### After any merge, always check

```bash
# 1. Both package versions must match, or release.yml will refuse
node -p "require('./package.json').version"
node -p "require('./cli/package.json').version"

# 2. Your release infrastructure must still exist
ls Dockerfile.prebuilt .github/workflows/release.yml scripts/release.js
```

The script runs both of these checks for you.

---

## Verified behaviour

This flow was tested against a simulated parent release. Results:

- ✅ Dry run correctly listed new commits and predicted the `README.md` conflict
- ✅ Merge landed on `sync/upstream-*`, leaving `master` untouched
- ✅ Fork-exclusive files survived the merge
- ✅ New upstream files propagated
- ✅ Upstream's version bump came through (`0.6.0` in both packages)
- ✅ Fork code patches in `open-sse/` survived alongside upstream's edits

---

## Why the fork stays a fork (and doesn't just rebase)

You could `git rebase` onto upstream, but you shouldn't here. Your fork adds
**~950 lines of release infrastructure** upstream doesn't have
(`release.yml`, `Dockerfile.prebuilt`, `docs/EASYPANEL.md`, `scripts/`). A
rebase replays your commits on a new base and forces you to re-resolve every
one; a merge resolves conflicts **once** and preserves history. Merge is the
right tool for a fork that adds its own layer.

---

## One-time setup (already done in this repo)

The remotes exist locally. They live in `.git/config`, so a **fresh clone won't
have them** — the script re-adds them automatically, but for reference:

```bash
git remote add upstream https://github.com/andyvandaric/9router
git remote set-url --push upstream DISABLED   # fetch-only, so you can't push upstream by accident
git remote add root https://github.com/decolua/9router
git remote set-url --push root DISABLED
```
