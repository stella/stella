/**
 * Every first-party `@stll/*` package the lockfile resolves from npm must be
 * listed in `bunfig.toml`'s `minimumReleaseAgeExcludes`.
 *
 * The 5-day quarantine is a supply-chain control for third-party code. First-
 * party packages publish continuously, so they are excluded by name. The
 * failure this guards is not the exclusion itself but a PARTIAL one: a napi
 * package ships its platform binaries as separate `optionalDependencies`
 * published in the same minute. List the parent and forget the children and
 * the parent installs while every binary is quarantined — and because they are
 * optional, bun skips them without a word. The package then resolves, imports
 * cleanly, and throws on first use, on every platform.
 *
 * Bun matches these entries EXACTLY. A `@stll/*` glob is accepted and silently
 * ignored, which is why this cannot be solved by pattern and needs a guard.
 *
 * Run: `bun scripts/check-stll-quarantine-excludes.ts`
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LOCKFILE = "bun.lock";
const BUNFIG = "bunfig.toml";

/** Packages resolved from the workspace itself never hit the registry. */
const WORKSPACE_PROTOCOL = "workspace:";

const readExcludes = (bunfig: string): Set<string> => {
  const start = bunfig.indexOf("minimumReleaseAgeExcludes");
  if (start === -1) {
    return new Set();
  }
  const end = bunfig.indexOf("]", start);
  const block = bunfig.slice(start, end === -1 ? undefined : end);
  return new Set(
    [...block.matchAll(/"(?<name>@?[^"]+)"/gu)].flatMap((match) => {
      const name = match.groups?.["name"];
      return name === undefined ? [] : [name];
    }),
  );
};

/**
 * `@stll` packages the lockfile pulls from the registry. Workspace members
 * resolve locally and are never subject to the release-age gate.
 */
const readRegistryStllPackages = (lockfile: string): Set<string> =>
  new Set(
    // Scope plus exactly one segment. Bun also keys nested resolutions by
    // path ("@stll/web/@babel/core"); those are not package names.
    [...lockfile.matchAll(/"(?<name>@stll\/[^"/]+)":\s*\[/gu)].flatMap(
      (match) => {
        const name = match.groups?.["name"];
        if (name === undefined) {
          return [];
        }
        // The entry's own resolution follows the name; workspace members
        // carry the workspace protocol instead of a registry tarball.
        const entry = lockfile.slice(match.index, match.index + 400);
        return entry.includes(WORKSPACE_PROTOCOL) ? [] : [name];
      },
    ),
  );

const bunfig = readFileSync(path.join(REPO_ROOT, BUNFIG), "utf-8");
const lockfile = readFileSync(path.join(REPO_ROOT, LOCKFILE), "utf-8");

const excludes = readExcludes(bunfig);
const missing = [...readRegistryStllPackages(lockfile)]
  .filter((name) => !excludes.has(name))
  .sort();

if (missing.length > 0) {
  console.error(
    `${BUNFIG} minimumReleaseAgeExcludes is missing ${missing.length} first-party package(s):\n` +
      missing.map((name) => `  "${name}",`).join("\n") +
      `\n\nAdd them. Until then, a fresh publish of any of these installs ` +
      `partially: the quarantine blocks it, and an optionalDependency that ` +
      `is blocked is skipped silently, so the failure surfaces at runtime ` +
      `rather than at install.`,
  );
  process.exit(1);
}

console.log(
  `${BUNFIG}: all ${excludes.size} quarantine excludes cover every first-party package in ${LOCKFILE}.`,
);
