#!/usr/bin/env node

/**
 * Cut a fork release.
 *
 *   node scripts/release.js 0.6.0 "Release title" "Markdown notes"
 *   node scripts/release.js --tag-only 0.6.0
 *
 * Bumps both package versions (root `package.json` and `cli/package.json` must
 * stay in lockstep — `.github/workflows/release.yml` refuses to release when
 * they disagree with the tag), prepends a CHANGELOG section, commits, tags
 * `vX.Y.Z`, and pushes.
 *
 * Pushing the tag triggers `.github/workflows/release.yml`, which builds
 * `9router-latest.tgz` + `9router-<version>.tgz`, creates the GitHub Release,
 * and pushes the zero-build image to ghcr.io/<owner>/9router.
 *
 * DOCKER.md documents this script; it previously did not exist in the tree.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", ...options }).trim();
}

function parseArgs(argv) {
  const flags = { tagOnly: false, dryRun: false, noPush: false };
  const positional = [];

  for (const arg of argv) {
    if (arg === "--tag-only") flags.tagOnly = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--no-push") flags.noPush = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg.startsWith("-")) fail(`Unknown flag: ${arg}`);
    else positional.push(arg);
  }

  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));

if (flags.help) {
  console.log(`
Usage: node scripts/release.js [options] <version> ["title"] ["notes"]

  <version>   Semver without the leading v, e.g. 0.6.0 or 0.6.0-rc.1

Options:
  --tag-only  Tag the current commit without bumping versions or CHANGELOG
  --dry-run   Print what would happen; change nothing
  --no-push   Commit and tag locally, but do not push
`);
  process.exit(0);
}

const version = positional[0];
if (!version) fail("Missing <version>. Example: node scripts/release.js 0.6.0");

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`"${version}" is not a valid semver (expected e.g. 0.6.0 or 0.6.0-rc.1)`);
}

const tag = `v${version}`;
const title = positional[1] || tag;
const notes = positional[2] || "";

const rootPkgPath = path.join(rootDir, "package.json");
const cliPkgPath = path.join(rootDir, "cli", "package.json");
const changelogPath = path.join(rootDir, "CHANGELOG.md");

// Refuse to release on a dirty tree: the tag must point at a commit that
// contains exactly the version bumps this script writes.
if (!flags.tagOnly) {
  const dirty = git(["status", "--porcelain"]);
  if (dirty) {
    fail(`Working tree is not clean:\n\n${dirty}\n\nCommit or stash first.`);
  }
}

if (git(["tag", "--list", tag])) fail(`Tag ${tag} already exists.`);
if (!flags.tagOnly && git(["rev-parse", "--abbrev-ref", "HEAD"]) !== "master") {
  console.warn(`⚠ Not on master (on ${git(["rev-parse", "--abbrev-ref", "HEAD"])}) — continuing anyway.`);
}

const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
const cliPkg = JSON.parse(fs.readFileSync(cliPkgPath, "utf8"));

if (flags.tagOnly) {
  console.log(`Tag-only mode: tagging ${git(["rev-parse", "--short", "HEAD"])} as ${tag}`);
} else {
  const previous = rootPkg.version;
  if (previous === version) fail(`Version is already ${version}.`);

  const date = new Date().toISOString().slice(0, 10);
  const section = `# ${tag} (${date})\n\n${notes || "- (no notes provided)"}\n\n`;

  console.log(`Bumping ${previous} → ${version}`);
  console.log(`  package.json       ${rootPkg.version} → ${version}`);
  console.log(`  cli/package.json   ${cliPkg.version} → ${version}`);
  console.log(`  CHANGELOG.md       prepend "# ${tag} (${date})"`);

  if (!flags.dryRun) {
    rootPkg.version = version;
    cliPkg.version = version;
    fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
    fs.writeFileSync(cliPkgPath, JSON.stringify(cliPkg, null, 2) + "\n");

    let changelog = "";
    try {
      changelog = fs.readFileSync(changelogPath, "utf8");
    } catch {
      console.warn("⚠ CHANGELOG.md not found — creating it");
    }
    fs.writeFileSync(changelogPath, section + changelog);

    console.log("\nStaging changes…");
    git(["add", "package.json", "cli/package.json", "CHANGELOG.md"]);
    git(["commit", "-m", `chore(release): ${tag} — ${title}`]);
    console.log(`Committed ${git(["rev-parse", "--short", "HEAD"])}`);
  }
}

console.log(`\nCreating tag ${tag}`);
if (!flags.dryRun) {
  git(["tag", "-a", tag, "-m", title]);
}

if (flags.noPush || flags.dryRun) {
  console.log(`\nSkipping push. To publish:\n  git push origin master && git push origin ${tag}`);
} else {
  console.log("Pushing master and the tag…");
  git(["push", "origin", "master"]);
  git(["push", "origin", tag], { stdio: "inherit" });
  console.log(`
✔ Pushed ${tag}.

GitHub Actions (.github/workflows/release.yml) now builds:
  • 9router-${version}.tgz + 9router-latest.tgz   (GitHub Release assets)
  • ghcr.io/<owner>/9router:${version}${version.includes("-") ? "" : " and :latest"}

Track it:  gh run watch
`);
}
