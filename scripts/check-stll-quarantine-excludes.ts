/**
 * Guard `bunfig.toml`'s `minimumReleaseAgeExcludes`:
 *
 * 1. Every first-party `@stll/*` package the lockfile resolves from npm must
 *    be excluded.
 * 2. A temporary third-party exclusion annotated with
 *    `# quarantine-expires: <timestamp>` fails at that timestamp, when Bun's
 *    release-age gate can take over again.
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
const EXPIRY_MARKER = "quarantine-expires:";
const EXACT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Packages resolved from the workspace itself never hit the registry. */
const WORKSPACE_PROTOCOL = "workspace:";

const readExcludeBlock = (bunfig: string): string => {
  const start = bunfig.indexOf("minimumReleaseAgeExcludes");
  if (start === -1) {
    return "";
  }
  const end = bunfig.indexOf("]", start);
  return bunfig.slice(start, end === -1 ? undefined : end);
};

const readExcludes = (bunfig: string): Set<string> => {
  const block = readExcludeBlock(bunfig);
  return new Set(
    [...block.matchAll(/"(?<name>@?[^"]+)"/gu)].flatMap((match) => {
      const name = match.groups?.["name"];
      return name === undefined ? [] : [name];
    }),
  );
};

type TemporaryExclude = {
  name: string;
  expiresAt: string;
};

type TemporaryExcludesResult = {
  entries: TemporaryExclude[];
  errors: string[];
};

const readTemporaryExcludes = (bunfig: string): TemporaryExcludesResult => {
  const entries: TemporaryExclude[] = [];
  const errors: string[] = [];

  for (const line of readExcludeBlock(bunfig).split("\n")) {
    if (!line.includes(EXPIRY_MARKER)) {
      continue;
    }

    const commentStart = line.indexOf("#");
    const declaration = line.slice(0, commentStart).trim();
    const comment = line.slice(commentStart + 1).trim();
    const quotedName = declaration.endsWith(",")
      ? declaration.slice(0, -1).trim()
      : declaration;
    const isQuotedName =
      quotedName.startsWith('"') &&
      quotedName.endsWith('"') &&
      !quotedName.slice(1, -1).includes('"');
    if (!comment.startsWith(EXPIRY_MARKER) || !isQuotedName) {
      errors.push(
        `${BUNFIG} has a malformed temporary quarantine annotation: ${line.trim()}`,
      );
      continue;
    }

    const name = quotedName.slice(1, -1);
    const expiresAt = comment.slice(EXPIRY_MARKER.length).trim();
    const expiresAtMs = Date.parse(expiresAt);
    if (
      !EXACT_UTC_TIMESTAMP.test(expiresAt) ||
      Number.isNaN(expiresAtMs) ||
      new Date(expiresAtMs).toISOString() !== expiresAt
    ) {
      errors.push(
        `${BUNFIG} temporary quarantine exclude "${name}" has an invalid UTC expiry: ${expiresAt}`,
      );
      continue;
    }

    entries.push({ expiresAt, name });
  }

  return { entries, errors };
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
        // carry the workspace protocol instead of a registry tarball. Read to
        // the end of that line and no further: a fixed-width window spills
        // into the next entry, and one workspace neighbour then hides a
        // registry-resolved package from the coverage check entirely.
        const lineEnd = lockfile.indexOf("\n", match.index);
        const entry = lockfile.slice(
          match.index,
          lineEnd === -1 ? undefined : lineEnd,
        );
        return entry.includes(WORKSPACE_PROTOCOL) ? [] : [name];
      },
    ),
  );

export type QuarantineExcludeCheckResult = {
  errors: string[];
  excludeCount: number;
  firstPartyCount: number;
  activeTemporaryCount: number;
};

export const checkQuarantineExcludes = ({
  bunfig,
  lockfile,
  now = new Date(),
}: {
  bunfig: string;
  lockfile: string;
  now?: Date;
}): QuarantineExcludeCheckResult => {
  const excludes = readExcludes(bunfig);
  const firstPartyPackages = readRegistryStllPackages(lockfile);
  const missing = [...firstPartyPackages]
    .filter((name) => !excludes.has(name))
    .sort();
  const temporary = readTemporaryExcludes(bunfig);
  const errors = [...temporary.errors];

  if (missing.length > 0) {
    errors.push(
      `${BUNFIG} minimumReleaseAgeExcludes is missing ${missing.length} first-party package(s):\n${missing
        .map((name) => `  "${name}",`)
        .join(
          "\n",
        )}\n\nAdd them. Until then, a fresh publish of any of these installs ` +
        `partially: the quarantine blocks it, and an optionalDependency that ` +
        `is blocked is skipped silently, so the failure surfaces at runtime ` +
        `rather than at install.`,
    );
  }

  const nowMs = now.getTime();
  for (const { expiresAt, name } of temporary.entries) {
    if (nowMs < Date.parse(expiresAt)) {
      continue;
    }
    errors.push(
      `${BUNFIG} temporary quarantine exclude "${name}" expired at ${expiresAt}. ` +
        `Remove it: the configured release-age gate can admit the package now.`,
    );
  }

  return {
    activeTemporaryCount: temporary.entries.length,
    errors,
    excludeCount: excludes.size,
    firstPartyCount: firstPartyPackages.size,
  };
};

const main = () => {
  const result = checkQuarantineExcludes({
    bunfig: readFileSync(path.join(REPO_ROOT, BUNFIG), "utf-8"),
    lockfile: readFileSync(path.join(REPO_ROOT, LOCKFILE), "utf-8"),
  });

  if (result.errors.length > 0) {
    console.error(result.errors.join("\n\n"));
    process.exit(1);
  }

  console.log(
    `${BUNFIG}: ${result.excludeCount} quarantine excludes cover all ` +
      `${result.firstPartyCount} registry-backed first-party packages; ` +
      `${result.activeTemporaryCount} temporary exclude(s) remain active.`,
  );
};

if (import.meta.main) {
  main();
}
