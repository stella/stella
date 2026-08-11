/**
 * Guard `bunfig.toml`'s `minimumReleaseAgeExcludes`:
 *
 * 1. Every first-party `@stll/*` package the lockfile resolves from npm must
 *    be excluded and record when that permanent exclusion began.
 * 2. A temporary third-party exclusion annotated with
 *    `# quarantine-expires: <timestamp>` must be removed once Bun's release-age
 *    gate can take over again.
 *
 * An expiry is a wall-clock instant, so failing at that instant turns every
 * open branch red at once for a change nobody made. Removal is automatic
 * instead: `quarantine-prune.yml` runs `--prune` hourly and opens the PR that
 * deletes the entry. An expired entry is therefore only a warning while that
 * PR waits to be merged, and fails once it has been ignored past the window.
 * It has to fail eventually: a stale exclude is not inert, because the next
 * version of that package published would skip the quarantine unnoticed.
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

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LOCKFILE = "bun.lock";
const BUNFIG = "bunfig.toml";
const SCRIPT_PATH = "scripts/check-stll-quarantine-excludes.ts";
const EXPIRY_MARKER = "quarantine-expires:";
const EXCLUDED_SINCE_MARKER = "quarantine-excluded-since:";
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

const excludeDeclaration = (line: string): string | undefined =>
  /^\s*"(?<name>[^"]+)",?\s*(?:#.*)?$/u.exec(line)?.groups?.["name"];

const exactUtcTimestampError = ({
  marker,
  name,
  timestamp,
}: {
  marker: string;
  name: string;
  timestamp: string;
}): string | undefined => {
  const timestampMs = Date.parse(timestamp);
  if (
    EXACT_UTC_TIMESTAMP.test(timestamp) &&
    !Number.isNaN(timestampMs) &&
    new Date(timestampMs).toISOString() === timestamp
  ) {
    return undefined;
  }
  return `${BUNFIG} minimum-release-age exclude "${name}" has an invalid ${marker} UTC timestamp: ${timestamp}`;
};

const readExcludeAnnotationErrors = (bunfig: string, now: Date): string[] => {
  const lines = readExcludeBlock(bunfig).split("\n");
  const declaredNames = new Set(
    lines.flatMap((line) => {
      const name = excludeDeclaration(line);
      return name === undefined ? [] : [name];
    }),
  );
  const unrecognizedEntries = [...readExcludes(bunfig)].filter(
    (name) => !declaredNames.has(name),
  );
  const errors =
    unrecognizedEntries.length === 0
      ? []
      : [
          `${BUNFIG} minimumReleaseAgeExcludes must declare one annotated package per line; unrecognized entries: ${unrecognizedEntries.join(", ")}`,
        ];

  errors.push(
    ...lines.flatMap((line) => {
      const name = excludeDeclaration(line);
      if (name === undefined) {
        return [];
      }

      if (!name.startsWith("@stll/")) {
        if (!line.includes(EXPIRY_MARKER)) {
          return [
            `${BUNFIG} third-party quarantine exclude "${name}" is missing an exact UTC expiry`,
          ];
        }
        return [];
      }

      if (!line.includes(EXCLUDED_SINCE_MARKER)) {
        return [
          `${BUNFIG} first-party quarantine exclude "${name}" is missing an exact UTC exclusion date`,
        ];
      }

      const excludedSince = line
        .slice(
          line.indexOf(EXCLUDED_SINCE_MARKER) + EXCLUDED_SINCE_MARKER.length,
        )
        .trim();
      const invalid = exactUtcTimestampError({
        marker: "exclusion-date",
        name,
        timestamp: excludedSince,
      });
      if (invalid !== undefined) {
        return [invalid];
      }
      if (Date.parse(excludedSince) > now.getTime()) {
        return [
          `${BUNFIG} first-party quarantine exclude "${name}" has a future exclusion date: ${excludedSince}`,
        ];
      }
      return [];
    }),
  );
  return errors;
};

type TemporaryExclude = {
  name: string;
  expiresAt: string;
};

type TemporaryExcludesResult = {
  entries: TemporaryExclude[];
  errors: string[];
};

type ParsedTemporaryExclude =
  | { error: string; kind: "error" }
  | { expiresAt: string; kind: "entry"; name: string };

/**
 * One annotated line. Both the guard and the prune read it through here, so
 * neither can disagree with the other about what a line means.
 */
const parseTemporaryExcludeLine = (line: string): ParsedTemporaryExclude => {
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
    return {
      error: `${BUNFIG} has a malformed temporary quarantine annotation: ${line.trim()}`,
      kind: "error",
    };
  }

  const name = quotedName.slice(1, -1);
  const expiresAt = comment.slice(EXPIRY_MARKER.length).trim();
  if (
    exactUtcTimestampError({
      marker: "expiry",
      name,
      timestamp: expiresAt,
    }) !== undefined
  ) {
    return {
      error: `${BUNFIG} temporary quarantine exclude "${name}" has an invalid UTC expiry: ${expiresAt}`,
      kind: "error",
    };
  }

  return { expiresAt, kind: "entry", name };
};

const readTemporaryExcludes = (bunfig: string): TemporaryExcludesResult => {
  const entries: TemporaryExclude[] = [];
  const errors: string[] = [];

  for (const line of readExcludeBlock(bunfig).split("\n")) {
    if (!line.includes(EXPIRY_MARKER)) {
      continue;
    }

    const parsed = parseTemporaryExcludeLine(line);
    if (parsed.kind === "error") {
      errors.push(parsed.error);
      continue;
    }

    entries.push({ expiresAt: parsed.expiresAt, name: parsed.name });
  }

  return { entries, errors };
};

/**
 * `@stll` packages the lockfile pulls from the registry. Workspace members
 * resolve locally and are never subject to the release-age gate.
 */
const readRegistryStllPackages = (lockfile: string): Set<string> =>
  new Set(
    // The key can be a nested resolution path such as
    // "@stll/folio-core/@stll/template-conditions". The first array value is
    // the resolved package identity, so derive the package name from it rather
    // than from the path.
    [
      ...lockfile.matchAll(
        /"[^"\n]+":\s*\["(?<name>@stll\/[^"@]+)@(?<source>[^"]+)"/gu,
      ),
    ].flatMap((match) => {
      const name = match.groups?.["name"];
      const source = match.groups?.["source"];
      if (name === undefined || source === undefined) {
        return [];
      }
      return source.startsWith(WORKSPACE_PROTOCOL) ? [] : [name];
    }),
  );

const HOUR_MS = 60 * 60 * 1000;
/** How long an expired entry is tolerated while its removal PR waits. */
const NOTICE_WINDOW_MS = 24 * HOUR_MS;

export type QuarantineExcludeCheckResult = {
  errors: string[];
  excludeCount: number;
  firstPartyCount: number;
  activeTemporaryCount: number;
  warnings: string[];
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
  const errors = [
    ...temporary.errors,
    ...readExcludeAnnotationErrors(bunfig, now),
  ];

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
  const warnings: string[] = [];
  for (const { expiresAt, name } of temporary.entries) {
    const expiresAtMs = Date.parse(expiresAt);

    if (nowMs >= expiresAtMs + NOTICE_WINDOW_MS) {
      errors.push(
        `${BUNFIG} temporary quarantine exclude "${name}" expired at ${expiresAt} ` +
          `and is still here. Remove it (\`bun ${SCRIPT_PATH} --prune\`): the ` +
          `release-age gate admits the package on its own now, and leaving the ` +
          `entry lets the next version of it publish straight past the quarantine.`,
      );
      continue;
    }

    if (nowMs >= expiresAtMs) {
      warnings.push(
        `${BUNFIG} temporary quarantine exclude "${name}" expired at ${expiresAt}. ` +
          `Its removal PR opens automatically; merge it, or run ` +
          `\`bun ${SCRIPT_PATH} --prune\` to do it by hand.`,
      );
    }
  }

  return {
    activeTemporaryCount: temporary.entries.length,
    errors,
    excludeCount: excludes.size,
    firstPartyCount: firstPartyPackages.size,
    warnings,
  };
};

export type PruneResult = {
  bunfig: string;
  pruned: string[];
};

/**
 * Drops the entries whose expiry has passed. Only the entry line goes: the
 * comments above the block explain why the remaining entries are there.
 */
export const pruneExpiredExcludes = ({
  bunfig,
  now = new Date(),
}: {
  bunfig: string;
  now?: Date;
}): PruneResult => {
  const blockStart = bunfig.indexOf("minimumReleaseAgeExcludes");
  if (blockStart === -1) {
    return { bunfig, pruned: [] };
  }
  const blockEnd = bunfig.indexOf("]", blockStart);
  const pruned: string[] = [];

  // Each line is judged by its own annotation. Matching by name instead would
  // delete every entry sharing that name, including one whose expiry was
  // renewed and has not passed.
  const block = bunfig
    .slice(blockStart, blockEnd)
    .split("\n")
    .filter((line) => {
      if (!line.includes(EXPIRY_MARKER)) {
        return true;
      }
      const parsed = parseTemporaryExcludeLine(line);
      // A malformed annotation is the guard's to report, not this to delete.
      if (parsed.kind !== "entry") {
        return true;
      }
      if (now.getTime() < Date.parse(parsed.expiresAt)) {
        return true;
      }
      pruned.push(parsed.name);
      return false;
    })
    .join("\n");

  if (pruned.length === 0) {
    return { bunfig, pruned: [] };
  }

  return {
    bunfig: bunfig.slice(0, blockStart) + block + bunfig.slice(blockEnd),
    pruned,
  };
};

const prune = () => {
  const bunfigPath = path.join(REPO_ROOT, BUNFIG);
  const { bunfig, pruned } = pruneExpiredExcludes({
    bunfig: readFileSync(bunfigPath, "utf-8"),
  });

  if (pruned.length === 0) {
    console.log(`${BUNFIG}: no expired quarantine excludes to remove.`);
    return;
  }

  writeFileSync(bunfigPath, bunfig);
  console.log(
    `${BUNFIG}: removed ${pruned.length} expired quarantine exclude(s): ${pruned.join(", ")}.`,
  );
};

const main = () => {
  if (process.argv.includes("--prune")) {
    prune();
    return;
  }

  const result = checkQuarantineExcludes({
    bunfig: readFileSync(path.join(REPO_ROOT, BUNFIG), "utf-8"),
    lockfile: readFileSync(path.join(REPO_ROOT, LOCKFILE), "utf-8"),
  });

  if (result.warnings.length > 0) {
    console.warn(`${result.warnings.join("\n")}\n`);
  }

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
