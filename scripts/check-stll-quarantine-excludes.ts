/**
 * Guard `bunfig.toml`'s `minimumReleaseAgeExcludes`:
 *
 * 1. Every first-party `@stll/*` package the lockfile resolves from npm must
 *    be excluded and record when that permanent exclusion began.
 * 2. A temporary third-party exclusion annotated with
 *    `# quarantine-expires: <timestamp>` must be removed once Bun's release-age
 *    gate can take over again.
 *
 * Wall-clock expiry blocks changes to the owning installation files. Other
 * changes receive a warning; main and scheduled checks remain blocking.
 * Structural policy errors always block every check.
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

import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { trackedPolicyFiles } from "./dated-waiver-tracked-files";
import {
  expiryBlocksFiles,
  expiryWarning,
  readExpiryCheckScope,
  type ExpiryCheckScope,
} from "./expiry-check-scope";

/** The guard, inventory, and prune share the complete tracked bunfig scan. */
export const quarantineBunfigFiles = (
  trackedFiles: readonly string[],
): string[] =>
  trackedFiles.filter(
    (file) =>
      path.posix.basename(file) === "bunfig.toml" &&
      !file.split("/").includes("node_modules"),
  );

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LOCKFILE = "bun.lock";
const BUNFIG = "bunfig.toml";
const SCRIPT_PATH = "scripts/check-stll-quarantine-excludes.ts";
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

      if (name.includes("*")) {
        return [
          `${BUNFIG} quarantine exclude "${name}" must name an exact package; Bun does not expand globs`,
        ];
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

export const quarantineOwningFiles = ({
  bunfigFile,
  packageName,
  packageManifests = {},
  basePackageManifests = {},
}: {
  bunfigFile: string;
  packageName: string;
  packageManifests?: Readonly<Record<string, string>>;
  basePackageManifests?: Readonly<Record<string, string>>;
}): string[] => {
  const dir = path.posix.dirname(bunfigFile);
  const manifests = [
    ...Object.entries(packageManifests),
    ...Object.entries(basePackageManifests),
  ].flatMap(([file, text]) => {
    if (dir !== "." && !file.startsWith(`${dir}/`)) {
      return [];
    }
    const manifest: unknown = JSON.parse(text);
    if (typeof manifest !== "object" || manifest === null) {
      return [];
    }
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "overrides",
      "resolutions",
      "catalog",
    ]) {
      if (!(field in manifest)) {
        continue;
      }
      const pins: unknown = Reflect.get(manifest, field);
      if (typeof pins === "object" && pins !== null && packageName in pins) {
        return [file];
      }
    }
    if ("catalogs" in manifest) {
      const catalogs = manifest.catalogs;
      if (typeof catalogs === "object" && catalogs !== null) {
        for (const catalog of Object.keys(catalogs)) {
          const pins: unknown = Reflect.get(catalogs, catalog);
          if (
            typeof pins === "object" &&
            pins !== null &&
            packageName in pins
          ) {
            return [file];
          }
        }
      }
    }
    return [];
  });
  return [
    bunfigFile,
    dir === "." ? LOCKFILE : `${dir}/${LOCKFILE}`,
    ...new Set(manifests),
  ];
};

const readBasePackageManifests = (
  scope: ExpiryCheckScope,
): Record<string, string> => {
  if (scope.type === "all" || scope.baseSha === undefined) {
    return {};
  }
  const listed = Bun.spawnSync(
    ["git", "ls-tree", "-r", "--name-only", "-z", scope.baseSha],
    { cwd: REPO_ROOT },
  );
  if (listed.exitCode !== 0) {
    return panic("Cannot enumerate base manifests for expiry ownership");
  }
  const files = listed.stdout
    .toString()
    .split("\0")
    .filter(
      (file) =>
        scope.changedFiles.has(file) &&
        path.posix.basename(file) === "package.json",
    );
  return Object.fromEntries(
    files.map((file) => {
      const contents = Bun.spawnSync(
        ["git", "show", `${scope.baseSha}:${file}`],
        { cwd: REPO_ROOT },
      );
      if (contents.exitCode !== 0) {
        return panic("Cannot read base manifest for expiry ownership");
      }
      return [file, contents.stdout.toString()];
    }),
  );
};

export type QuarantineExcludeCheckResult = {
  errors: string[];
  warnings: string[];
  excludeCount: number;
  firstPartyCount: number;
  activeTemporaryCount: number;
};

export const checkQuarantineExcludes = ({
  bunfig,
  lockfile,
  now = new Date(),
  releaseAgeExceptionSources = {},
  scope = { type: "all" },
  bunfigFile = BUNFIG,
  owningFiles = [bunfigFile, LOCKFILE],
  packageManifests = {},
  basePackageManifests = {},
}: {
  bunfig: string;
  lockfile: string;
  scope?: ExpiryCheckScope;
  bunfigFile?: string;
  owningFiles?: readonly string[];
  packageManifests?: Readonly<Record<string, string>>;
  basePackageManifests?: Readonly<Record<string, string>>;
  now?: Date;
  releaseAgeExceptionSources?: Readonly<Record<string, string>>;
}): QuarantineExcludeCheckResult => {
  const excludes = readExcludes(bunfig);
  const firstPartyPackages = readRegistryStllPackages(lockfile);
  const missing = [...firstPartyPackages]
    .filter((name) => !excludes.has(name))
    .toSorted();
  const temporary = readTemporaryExcludes(bunfig);
  const warnings: string[] = [];
  const releaseAgeExceptions = readReleaseAgeExceptions(
    releaseAgeExceptionSources,
  );
  const errors = [
    ...temporary.errors,
    ...readExcludeAnnotationErrors(bunfig, now),
    ...releaseAgeExceptions.errors,
  ];

  for (const entry of releaseAgeExceptions.entries) {
    if (Date.parse(entry.expiresAt) > now.getTime()) {
      continue;
    }
    const message = `${entry.source}:${entry.line} release-age quarantine exception expired at ${entry.expiresAt}`;
    if (expiryBlocksFiles(scope, [entry.source])) {
      errors.push(message);
    } else {
      warnings.push(
        `${message}. Remove the exception or provide an owner-approved extension.`,
      );
    }
  }

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
    const expiresAtMs = Date.parse(expiresAt);

    if (nowMs >= expiresAtMs) {
      const messages = expiryBlocksFiles(scope, [
        ...owningFiles,
        ...quarantineOwningFiles({
          bunfigFile,
          packageName: name,
          packageManifests,
          basePackageManifests,
        }),
      ])
        ? errors
        : warnings;
      messages.push(
        `${bunfigFile} temporary quarantine exclude "${name}" expired at ${expiresAt} ` +
          `and is still here. Remove it (\`bun ${SCRIPT_PATH} --prune\`): the ` +
          `release-age gate admits the package on its own now, and leaving the ` +
          `entry lets the next version of it publish straight past the quarantine.`,
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

export const pruneQuarantineBunfigs = ({
  bunfigs,
  now = new Date(),
}: {
  bunfigs: Readonly<Record<string, string>>;
  now?: Date;
}): Record<string, PruneResult> =>
  Object.fromEntries(
    Object.entries(bunfigs).map(([file, bunfig]) => [
      file,
      pruneExpiredExcludes({ bunfig, now }),
    ]),
  );

const main = () => {
  const tracked = trackedPolicyFiles();
  const bunfigFiles = quarantineBunfigFiles(tracked);
  const bunfigs = Object.fromEntries(
    bunfigFiles.map((file) => [
      file,
      readFileSync(path.join(REPO_ROOT, file), "utf-8"),
    ]),
  );
  if (process.argv.includes("--prune")) {
    for (const [file, result] of Object.entries(
      pruneQuarantineBunfigs({ bunfigs }),
    )) {
      if (result.pruned.length === 0) {
        continue;
      }
      writeFileSync(path.join(REPO_ROOT, file), result.bunfig);
      console.log(
        `${file}: removed expired quarantine excludes: ${result.pruned.join(", ")}.`,
      );
    }
    return;
  }
  const scope = readExpiryCheckScope();
  const basePackageManifests = readBasePackageManifests(scope);
  const errors: string[] = [];
  for (const [file, bunfig] of Object.entries(bunfigs)) {
    const dir = path.posix.dirname(file);
    const lockfile = dir === "." ? LOCKFILE : `${dir}/${LOCKFILE}`;
    const manifests = tracked.filter(
      (manifest) =>
        path.posix.basename(manifest) === "package.json" &&
        (dir === "." || manifest.startsWith(`${dir}/`)),
    );
    const result = checkQuarantineExcludes({
      bunfig,
      bunfigFile: file,
      lockfile: tracked.includes(lockfile)
        ? readFileSync(path.join(REPO_ROOT, lockfile), "utf-8")
        : "",
      owningFiles: [file, lockfile],
      basePackageManifests,
      packageManifests: Object.fromEntries(
        manifests.map((manifest) => [
          manifest,
          readFileSync(path.join(REPO_ROOT, manifest), "utf-8"),
        ]),
      ),
      scope,
      releaseAgeExceptionSources:
        file === BUNFIG
          ? Object.fromEntries(
              RELEASE_AGE_EXCEPTION_SOURCES.map((source) => [
                source,
                readFileSync(path.join(REPO_ROOT, source), "utf-8"),
              ]),
            )
          : {},
    });
    errors.push(
      ...result.errors.map((error) =>
        error.startsWith(`${BUNFIG} `)
          ? file + error.slice(BUNFIG.length)
          : error,
      ),
    );
    for (const warning of result.warnings) {
      console.warn(expiryWarning(warning));
    }
  }
  if (errors.length > 0) {
    console.error(errors.join("\n\n"));
    process.exit(1);
  }
  console.log("Quarantine excludes satisfy installation policy.");
};

if (import.meta.main) {
  main();
}
