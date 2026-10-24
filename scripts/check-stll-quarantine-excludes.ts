/**
 * Guard `bunfig.toml`'s `minimumReleaseAgeExcludes`:
 *
 * 1. Every first-party `@stll/*` package the lockfile resolves from npm must
 *    be excluded and record when that permanent exclusion began.
 * 2. A temporary third-party exclusion carries an exact
 *    `# quarantine-expires: <timestamp>` annotation, removed once Bun's
 *    release-age gate can take over again.
 *
 * This guard checks the annotations' shape, never their expiry. An expiry is
 * a wall-clock instant, so failing at that instant would turn every open
 * branch red at once for a change nobody made. Instead the expiry has owners
 * that cannot: `quarantine-prune.yml` runs `--prune` hourly and opens the PR
 * that deletes the entry, scripts/dated-waivers.ts inventories it, and
 * scripts/check-lockfile-release-ages.ts stops exempting the package once its
 * entry has expired, so a stale exclude cannot let the next version of that
 * package skip the quarantine.
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
const EXPIRY_MARKER = "quarantine-expires:";
const EXCLUDED_SINCE_MARKER = "quarantine-excluded-since:";
export const RELEASE_AGE_EXCEPTION_SOURCES = ["docker-compose.yml"] as const;
const RELEASE_AGE_EXCEPTION_MARKER = "release-age-quarantine-exception:";
const EXACT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Packages resolved from the workspace itself never hit the registry. */
const WORKSPACE_PROTOCOL = "workspace:";

type ExcludeBlockRange = {
  end: number;
  start: number;
};

const findExcludeBlockRange = (
  bunfig: string,
): ExcludeBlockRange | undefined => {
  const declaration = /^[\t ]*minimumReleaseAgeExcludes[\t ]*=/mu.exec(bunfig);
  if (declaration === null) {
    return undefined;
  }

  const start = declaration.index;
  const arrayStart = bunfig.indexOf("[", start);
  if (arrayStart === -1) {
    return undefined;
  }

  let state: "basic" | "comment" | "literal" | "plain" = "plain";
  let escaped = false;
  for (let index = arrayStart; index < bunfig.length; index++) {
    const character = bunfig[index];
    if (state === "comment") {
      if (character === "\n") {
        state = "plain";
      }
      continue;
    }
    if (state === "basic") {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        state = "plain";
      }
      continue;
    }
    if (state === "literal") {
      if (character === "'") {
        state = "plain";
      }
      continue;
    }
    if (character === "#") {
      state = "comment";
    } else if (character === '"') {
      state = "basic";
    } else if (character === "'") {
      state = "literal";
    } else if (character === "]") {
      return { end: index, start };
    }
  }
  return undefined;
};

const readExcludeBlock = (bunfig: string): string => {
  const range = findExcludeBlockRange(bunfig);
  return range === undefined ? "" : bunfig.slice(range.start, range.end);
};

const readInstallTable = (bunfig: string): object | undefined => {
  const parsed = Bun.TOML.parse(bunfig);
  if (!("install" in parsed)) {
    return undefined;
  }
  const install = parsed.install;
  return typeof install === "object" && install !== null ? install : undefined;
};

/**
 * `[install] minimumReleaseAge` in seconds, as Bun reads it; undefined when
 * the file sets none, which leaves installs from its directory unquarantined.
 */
const readMinimumReleaseAgeSeconds = (bunfig: string): number | undefined => {
  const install = readInstallTable(bunfig);
  if (install === undefined || !("minimumReleaseAge" in install)) {
    return undefined;
  }
  const seconds = install.minimumReleaseAge;
  return typeof seconds === "number" && seconds > 0 ? seconds : undefined;
};

/** The names Bun exempts from the release-age gate: exact matches only. */
const readExcludes = (bunfig: string): Set<string> => {
  const install = readInstallTable(bunfig);
  if (install === undefined) {
    return new Set();
  }
  if (!("minimumReleaseAgeExcludes" in install)) {
    return new Set();
  }
  const excludes = install.minimumReleaseAgeExcludes;
  if (!Array.isArray(excludes)) {
    return new Set();
  }
  return new Set(excludes.filter((name) => typeof name === "string"));
};

/**
 * `[install] auto`, as Bun reads it; undefined when the file sets none, which
 * Bun treats as "auto".
 */
const readAutoInstall = (bunfig: string): string | undefined => {
  const install = readInstallTable(bunfig);
  if (install === undefined || !("auto" in install)) {
    return undefined;
  }
  return typeof install.auto === "string" ? install.auto : undefined;
};

export type InstallPolicy = {
  /** `[install] auto`: whether Bun installs a missing import at run time. */
  readonly autoInstall: string | undefined;
  readonly excludes: ReadonlySet<string>;
  /** Seconds; undefined when the file leaves its directory unquarantined. */
  readonly minimumReleaseAge: number | undefined;
};

/**
 * What a bunfig.toml sets for installs: the release-age gate and run-time
 * installs. Every guard that asks whether a directory is quarantined, which
 * names it exempts, or whether Bun may install there at run time reads it
 * through here, so no two of them can disagree about it.
 */
export const readInstallPolicy = (bunfig: string): InstallPolicy => ({
  autoInstall: readAutoInstall(bunfig),
  excludes: readExcludes(bunfig),
  minimumReleaseAge: readMinimumReleaseAgeSeconds(bunfig),
});

const excludeDeclaration = (line: string): string | undefined =>
  /^\s*"(?<name>[^"]+)",?\s*(?:#.*)?$/u.exec(line)?.groups?.["name"];

const TOML_ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\u001b",
  '"': '"',
  "\\": "\\",
};

/** The value of a TOML basic string body, so every spelling of a name is one key. */
const decodeBasicString = (raw: string): string =>
  raw.replaceAll(
    /\\(?:u([\da-fA-F]{4})|U([\da-fA-F]{8})|([btnfre"\\]))/gu,
    (
      escape: string,
      short: string | undefined,
      long: string | undefined,
      single: string | undefined,
    ) => {
      const code = short ?? long;
      if (code !== undefined) {
        return String.fromCodePoint(Number.parseInt(code, 16));
      }
      return TOML_ESCAPES[single ?? ""] ?? escape;
    },
  );

const readDuplicateExcludeErrors = (bunfig: string): string[] => {
  const range = findExcludeBlockRange(bunfig);
  if (range === undefined) {
    return [];
  }

  const firstBlockLine = bunfig.slice(0, range.start).split("\n").length;
  const declarationLines = new Map<string, number[]>();
  for (const [index, line] of bunfig
    .slice(range.start, range.end)
    .split("\n")
    .entries()) {
    const raw = excludeDeclaration(line);
    if (raw === undefined) {
      continue;
    }
    const name = decodeBasicString(raw);
    const lineNumbers = declarationLines.get(name) ?? [];
    lineNumbers.push(firstBlockLine + index);
    declarationLines.set(name, lineNumbers);
  }

  return [...declarationLines]
    .filter(([, lineNumbers]) => lineNumbers.length > 1)
    .map(
      ([name, lineNumbers]) =>
        `${BUNFIG} minimumReleaseAgeExcludes lists duplicate package "${name}" on lines ${lineNumbers.join(", ")}`,
    );
};

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

type ReleaseAgeException = { source: string; line: number; expiresAt: string };
type ReleaseAgeExceptionsResult = {
  entries: ReleaseAgeException[];
  errors: string[];
};

export const readReleaseAgeExceptions = (
  sources: Readonly<Record<string, string>>,
): ReleaseAgeExceptionsResult => {
  const entries: ReleaseAgeException[] = [];
  const errors: string[] = [];
  for (const [source, contents] of Object.entries(sources)) {
    for (const [index, line] of contents.split("\n").entries()) {
      const markerIndex = line.indexOf(RELEASE_AGE_EXCEPTION_MARKER);
      if (markerIndex === -1) {
        continue;
      }
      const expiresAt = line
        .slice(markerIndex + RELEASE_AGE_EXCEPTION_MARKER.length)
        .trim();
      const timestampMs = Date.parse(expiresAt);
      if (
        !EXACT_UTC_TIMESTAMP.test(expiresAt) ||
        !Number.isFinite(timestampMs) ||
        new Date(timestampMs).toISOString() !== expiresAt
      ) {
        errors.push(
          `${source}:${index + 1} release-age quarantine exception is missing an exact UTC expiry`,
        );
        continue;
      }
      entries.push({ source, line: index + 1, expiresAt });
    }
  }
  return { entries, errors };
};

export type TemporaryExclude = {
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

export const readTemporaryExcludes = (
  bunfig: string,
): TemporaryExcludesResult => {
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
  releaseAgeExceptionSources = {},
}: {
  bunfig: string;
  lockfile: string;
  now?: Date;
  releaseAgeExceptionSources?: Readonly<Record<string, string>>;
}): QuarantineExcludeCheckResult => {
  const excludes = readExcludes(bunfig);
  const firstPartyPackages = readRegistryStllPackages(lockfile);
  const missing = [...firstPartyPackages]
    .filter((name) => !excludes.has(name))
    .toSorted();
  const temporary = readTemporaryExcludes(bunfig);
  const errors = [
    ...temporary.errors,
    ...readDuplicateExcludeErrors(bunfig),
    ...readExcludeAnnotationErrors(bunfig, now),
    ...readReleaseAgeExceptions(releaseAgeExceptionSources).errors,
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

  return {
    activeTemporaryCount: temporary.entries.length,
    errors,
    excludeCount: excludes.size,
    firstPartyCount: firstPartyPackages.size,
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
  const range = findExcludeBlockRange(bunfig);
  if (range === undefined) {
    return { bunfig, pruned: [] };
  }
  const pruned: string[] = [];

  // Each line is judged by its own annotation. Matching by name instead would
  // delete every entry sharing that name, including one whose expiry was
  // renewed and has not passed.
  const block = bunfig
    .slice(range.start, range.end)
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
    bunfig: bunfig.slice(0, range.start) + block + bunfig.slice(range.end),
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
    releaseAgeExceptionSources: Object.fromEntries(
      RELEASE_AGE_EXCEPTION_SOURCES.map((source) => [
        source,
        readFileSync(path.join(REPO_ROOT, source), "utf-8"),
      ]),
    ),
  });

  if (result.errors.length > 0) {
    console.error(result.errors.join("\n\n"));
    process.exit(1);
  }

  console.log(
    `${BUNFIG}: ${result.excludeCount} quarantine excludes cover all ` +
      `${result.firstPartyCount} registry-backed first-party packages; ` +
      `${result.activeTemporaryCount} temporary exclude(s) are listed.`,
  );
};

if (import.meta.main) {
  main();
}
