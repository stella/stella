#!/usr/bin/env bun

// Release guard: every package publish-npm.yml releases must be on npm at the
// version the repository carries.
//
// A publish run that fails, or never starts, leaves no trace anywhere a
// release looks: the next release tags, deploys and announces a CLI and
// libraries that users cannot install. This compares each publishable
// package's version at a git ref with npm's `latest` dist-tag and fails, with
// the whole table, when any package lags.
//
// It runs in two places:
//   - publish-npm.yml, after the publish, against the published commit, so a
//     run that did not deliver goes red with the table that says what is
//     missing;
//   - release-tag.yml, against the previous stable release tag, so a broken
//     publish blocks the next release instead of being carried along.
//
// The package list is publish-npm.yml's own (scripts/publish-packages.ts);
// a package marked `private` at the ref is skipped. Dependency-free: the
// release-tag job runs it before any install, so it uses only Bun, Node
// built-ins, git and npm.
//
//   bun scripts/check-npm-publish-lag.ts --ref <git-ref> [--packages cli,ui]
//   bun scripts/check-npm-publish-lag.ts --previous-release-of <git-ref>
//     [--attempts 10 --interval-seconds 30]
//
// Exit codes: 0 every package is on npm, 1 a package lags, 2 bad arguments or
// manifests, 3 the guard itself failed.

import path from "node:path";

import { ALL_PACKAGE_ORDER } from "./publish-packages";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const STABLE_TAG = /^v\d+\.\d+\.\d+$/u;

class NpmPublishLagError extends Error {
  readonly _tag = "NpmPublishLagError";

  constructor(message: string) {
    super(message);
    this.name = "NpmPublishLagError";
  }
}

const fail = (message: string): never => {
  throw new NpmPublishLagError(message);
};

/** What the registry says about one package name. */
export type RegistryView =
  | {
      readonly kind: "found";
      readonly latest: string | undefined;
      readonly versions: readonly string[];
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export type RegistryFetcher = (name: string) => Promise<RegistryView>;

type PublishablePackage = {
  /** Directory under packages/. */
  readonly directory: string;
  readonly name: string;
  readonly version: string;
};

type PackageLagStatus =
  /** npm's latest is the repository version or newer. */
  | "current"
  /** The repository version was never published. */
  | "unpublished"
  /** The version is on npm, but `latest` still points at an older one. */
  | "latest-behind"
  /** The registry did not answer for the package (missing, or not visible). */
  | "not-visible";

type PackageLag = PublishablePackage & {
  readonly npmLatest: string | undefined;
  readonly status: PackageLagStatus;
  readonly detail?: string;
};

export const classifyPackage = (
  pkg: PublishablePackage,
  view: RegistryView,
): PackageLag => {
  if (view.kind === "unavailable") {
    return {
      ...pkg,
      detail: view.reason,
      npmLatest: undefined,
      status: "not-visible",
    };
  }
  const { latest, versions } = view;
  if (latest !== undefined && Bun.semver.order(latest, pkg.version) >= 0) {
    return { ...pkg, npmLatest: latest, status: "current" };
  }
  return {
    ...pkg,
    npmLatest: latest,
    status: versions.includes(pkg.version) ? "latest-behind" : "unpublished",
  };
};

export const assessPublishLag = async (
  packages: readonly PublishablePackage[],
  fetchView: RegistryFetcher,
): Promise<PackageLag[]> =>
  Promise.all(
    packages.map(async (pkg) =>
      classifyPackage(pkg, await fetchView(pkg.name)),
    ),
  );

export const laggingPackages = (rows: readonly PackageLag[]): PackageLag[] =>
  rows.filter((row) => row.status !== "current");

/** A plain-text table, one row per package, widest cell sets each column. */
export const renderLagTable = (rows: readonly PackageLag[]): string => {
  const header = ["package", "repo", "npm latest", "status"];
  const body = rows.map((row) => [
    row.name,
    row.version,
    row.npmLatest ?? "-",
    row.detail === undefined ? row.status : `${row.status} (${row.detail})`,
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...body.map((line) => line[column]?.length ?? 0)),
  );
  return [header, ...body]
    .map((line) =>
      line
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The packages to check, read from manifests at one ref. A package missing at
 * the ref (added later) or marked `private` there is not expected on npm.
 */
export const readPublishablePackages = ({
  readManifest,
  only,
}: {
  /** Raw package.json text for packages/<directory>, or undefined if absent. */
  readonly readManifest: (directory: string) => string | undefined;
  readonly only?: readonly string[] | undefined;
}): PublishablePackage[] => {
  const known: readonly string[] = ALL_PACKAGE_ORDER;
  const unknown = (only ?? []).filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    fail(`unknown package(s): ${unknown.join(", ")}`);
  }
  const selected =
    only === undefined
      ? known
      : known.filter((directory) => only.includes(directory));
  return selected.flatMap((directory) => {
    const text = readManifest(directory);
    if (text === undefined) {
      return [];
    }
    const manifest: unknown = JSON.parse(text);
    if (
      !isRecord(manifest) ||
      typeof manifest["name"] !== "string" ||
      typeof manifest["version"] !== "string"
    ) {
      return fail(`packages/${directory}/package.json has no name or version`);
    }
    if (manifest["private"] === true) {
      return [];
    }
    return [
      { directory, name: manifest["name"], version: manifest["version"] },
    ];
  });
};

/** The newest stable `vX.Y.Z` tag among those listed, newest first. */
export const newestStableTag = (tags: readonly string[]): string | undefined =>
  tags.find((tag) => STABLE_TAG.test(tag));

type Attempt = {
  readonly attempts: number;
  readonly intervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
};

/**
 * Re-reads the registry while anything lags, so a publish that just finished
 * has time to show up. Only the registry is re-read; the verdict is the last
 * one.
 */
export const assessWithRetries = async (
  packages: readonly PublishablePackage[],
  fetchView: RegistryFetcher,
  { attempts, intervalMs, sleep }: Attempt,
): Promise<PackageLag[]> => {
  let rows = await assessPublishLag(packages, fetchView);
  for (
    let attempt = 1;
    attempt < attempts && laggingPackages(rows).length > 0;
    attempt += 1
  ) {
    await sleep(intervalMs);
    rows = await assessPublishLag(packages, fetchView);
  }
  return rows;
};

const run = (
  command: readonly string[],
): { ok: boolean; stdout: string; stderr: string } => {
  const result = Bun.spawnSync([...command], {
    cwd: REPO_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
};

const asStrings = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

/** `npm view`, so a restricted package is read with the runner's own auth. */
const npmRegistryFetcher: RegistryFetcher = async (name) => {
  const proc = Bun.spawn({
    cmd: ["npm", "view", name, "dist-tags", "versions", "--json"],
    cwd: REPO_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const view = { ok: exitCode === 0, stderr, stdout };
  if (!view.ok) {
    const code =
      /npm (?:error|ERR!) code (\S+)/u.exec(view.stderr)?.[1] ??
      "npm view failed";
    return { kind: "unavailable", reason: code };
  }
  const parsed: unknown = JSON.parse(view.stdout);
  if (!isRecord(parsed) || !isRecord(parsed["dist-tags"])) {
    return { kind: "unavailable", reason: "unexpected npm view shape" };
  }
  const latest = parsed["dist-tags"]["latest"];
  const versions = parsed["versions"];
  return {
    kind: "found",
    latest: typeof latest === "string" ? latest : undefined,
    // npm prints a lone version as a string rather than a one-item array.
    versions: typeof versions === "string" ? [versions] : asStrings(versions),
  };
};

type Args = {
  readonly ref: string | undefined;
  readonly previousReleaseOf: string | undefined;
  readonly packages: readonly string[] | undefined;
  readonly attempts: number;
  readonly intervalSeconds: number;
};

export const parseArgs = (argv: readonly string[]): Args => {
  const values = new Map<string, string>();
  const flags = argv.values();
  for (const flag of flags) {
    const value = flags.next().value;
    if (value === undefined) {
      return fail(`${flag} requires a value`);
    }
    if (
      ![
        "--ref",
        "--previous-release-of",
        "--packages",
        "--attempts",
        "--interval-seconds",
      ].includes(flag)
    ) {
      return fail(`unknown argument: ${flag}`);
    }
    values.set(flag, value);
  }
  const ref = values.get("--ref");
  const previousReleaseOf = values.get("--previous-release-of");
  if ((ref === undefined) === (previousReleaseOf === undefined)) {
    return fail("pass exactly one of --ref or --previous-release-of");
  }
  const packages = values
    .get("--packages")
    ?.split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const attempts = Number(values.get("--attempts") ?? "1");
  const intervalSeconds = Number(values.get("--interval-seconds") ?? "30");
  if (!Number.isInteger(attempts) || attempts < 1) {
    return fail("--attempts must be a positive integer");
  }
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    return fail("--interval-seconds must be a non-negative number");
  }
  return {
    attempts,
    intervalSeconds,
    packages:
      packages !== undefined && packages.length > 0 ? packages : undefined,
    previousReleaseOf,
    ref,
  };
};

const resolveRef = (args: Args): string => {
  if (args.ref !== undefined) {
    return args.ref;
  }
  const tags = run([
    "git",
    "tag",
    "--merged",
    args.previousReleaseOf ?? "HEAD",
    "--list",
    "v*",
    "--sort=-v:refname",
  ]);
  if (!tags.ok) {
    return fail(`git tag --merged failed: ${tags.stderr.trim()}`);
  }
  return (
    newestStableTag(tags.stdout.split("\n").map((tag) => tag.trim())) ??
    fail(
      `no stable release tag is reachable from ${args.previousReleaseOf ?? "HEAD"}`,
    )
  );
};

const main = async (argv: readonly string[]): Promise<number> => {
  const args = parseArgs(argv);
  const ref = resolveRef(args);
  const packages = readPublishablePackages({
    only: args.packages,
    readManifest: (directory) => {
      const shown = run([
        "git",
        "show",
        `${ref}:packages/${directory}/package.json`,
      ]);
      return shown.ok ? shown.stdout : undefined;
    },
  });
  if (packages.length === 0) {
    return fail(`no publishable package found at ${ref}`);
  }
  const rows = await assessWithRetries(packages, npmRegistryFetcher, {
    attempts: args.attempts,
    intervalMs: args.intervalSeconds * 1000,
    sleep: async (ms) => {
      await Bun.sleep(ms);
    },
  });
  const table = renderLagTable(rows);
  const lagging = laggingPackages(rows);
  if (lagging.length === 0) {
    process.stdout.write(
      `npm-publish-lag: ok, ${rows.length} package(s) at ${ref} are on npm.\n${table}\n`,
    );
    return 0;
  }
  process.stderr.write(
    `::error::npm-publish-lag: ${lagging.length} package(s) at ${ref} are not on npm: ${lagging
      .map((row) => `${row.name}@${row.version} (${row.status})`)
      .join(
        ", ",
      )}. Publish them with publish-npm.yml before releasing again.\n${table}\n`,
  );
  return 1;
};

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    // Exit 1 means "a package lags" and nothing else: release-tag.yml lets an
    // explicit input accept that one outcome, never a guard that broke.
    process.stderr.write(
      `::error::npm-publish-lag: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(error instanceof NpmPublishLagError ? 2 : 3);
  }
}
