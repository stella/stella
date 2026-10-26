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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ALL_PACKAGE_ORDER } from "./publish-packages";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
export const STABLE_RELEASE_TAG = /^v\d+\.\d+\.\d+$/u;

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

export const DAY_SECONDS = 24 * 60 * 60;
const SEMVER = /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/u;

type RegistryCheckResult =
  | { status: "passed"; reason: "ok" }
  | { status: "passed"; reason: "published_from_declared_repository" }
  | { status: "skipped"; reason: "publish_pending" }
  // npm's `latest`, so callers can tell a lagging registry from one ahead.
  | { status: "failed"; reason: "version_mismatch"; latest: string }
  | {
      status: "failed";
      reason:
        "http_status" | "timeout" | "contract_error" | "unattested_publish";
    };

type RepositoryField = string | { url: string };

export const normalizeGitHubRepository = (
  repository: RepositoryField | undefined,
): string | undefined => {
  const value = typeof repository === "string" ? repository : repository?.url;
  if (value === undefined) {
    return undefined;
  }
  try {
    const url = new URL(value.replace(/^git\+/u, ""));
    const segments = url.pathname.split("/").filter(Boolean);
    const repositoryName = segments.at(-1);
    if (repositoryName?.endsWith(".git") === true) {
      segments[segments.length - 1] = repositoryName.slice(0, -".git".length);
    }
    return url.hostname.toLowerCase() === "github.com" && segments.length === 2
      ? `github.com/${segments.join("/")}`.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
};

export const versionBumpTime = (history: string): number | undefined => {
  for (const commit of history.split("journey-commit ").slice(1)) {
    const timestamp = Number(commit.split("\n").at(0));
    const oldVersion = /^-\s*"version"\s*:\s*"([^"]+)"/mu.exec(commit)?.at(1);
    const newVersion = /^\+\s*"version"\s*:\s*"([^"]+)"/mu.exec(commit)?.at(1);
    if (
      oldVersion &&
      newVersion &&
      oldVersion !== newVersion &&
      Number.isFinite(timestamp)
    ) {
      return timestamp;
    }
  }
  return undefined;
};

const PUBLISHED_VERSION_POLICY = {
  release: "minimum",
  journey: "exact",
} as const;

type ComparePublishedVersionOptions = {
  latest: string | undefined;
  target: string;
} & (
  | { policy: typeof PUBLISHED_VERSION_POLICY.release }
  | {
      policy: typeof PUBLISHED_VERSION_POLICY.journey;
      bumpedAt: number | undefined;
      now: number;
    }
);

const comparePublishedVersion = ({
  latest,
  target,
  ...options
}: ComparePublishedVersionOptions): "current" | "pending" | "mismatch" => {
  switch (options.policy) {
    case PUBLISHED_VERSION_POLICY.release:
      return latest !== undefined && Bun.semver.order(latest, target) >= 0
        ? "current"
        : "mismatch";
    case PUBLISHED_VERSION_POLICY.journey:
      if (latest === target) {
        return "current";
      }
      return options.bumpedAt !== undefined &&
        options.bumpedAt <= options.now &&
        options.now - options.bumpedAt < DAY_SECONDS
        ? "pending"
        : "mismatch";
    default: {
      options satisfies never;
      throw new NpmPublishLagError("Unhandled version policy");
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const repositoryField = (value: unknown): RepositoryField | undefined => {
  if (typeof value === "string") {
    return value;
  }
  return isRecord(value) && typeof value["url"] === "string"
    ? { url: value["url"] }
    : undefined;
};

type NpmRunOptions = {
  args: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
};

export type NpmRunResult = { exitCode: number; stdout: string };
export type NpmRunner = (options: NpmRunOptions) => Promise<NpmRunResult>;

const runNpm: NpmRunner = async ({ args, cwd, env, timeoutMs }) => {
  const child = Bun.spawn(["npm", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "ignore",
    timeout: timeoutMs,
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stdout };
};

const packageEntryMatches = (
  value: unknown,
  name: string,
  version: string,
): boolean =>
  isRecord(value) && value["name"] === name && value["version"] === version;

// The audit runs on a pinned npm whose `--include-attestations` JSON lists
// each verified package with its verified attestation bundles. Older npm
// prints failures only, which is no evidence that an attestation was checked.
const NPM_AUDIT_VERSION = "11.20.0";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";

type ProvenanceExpectation = { subject: string; repository: string };

// Reads the in-toto statement of one bundle npm reported as verified, so the
// subject and source repository come from the same signed envelope npm checked.
const statementMatches = (
  bundle: unknown,
  expected: ProvenanceExpectation,
): boolean => {
  if (!isRecord(bundle) || bundle["predicateType"] !== SLSA_PROVENANCE_V1) {
    return false;
  }
  const sigstore = bundle["bundle"];
  const envelope = isRecord(sigstore) ? sigstore["dsseEnvelope"] : undefined;
  if (!isRecord(envelope) || typeof envelope["payload"] !== "string") {
    return false;
  }
  const statement: unknown = JSON.parse(
    Buffer.from(envelope["payload"], "base64").toString("utf-8"),
  );
  if (!isRecord(statement) || !Array.isArray(statement["subject"])) {
    return false;
  }
  const predicate = statement["predicate"];
  const buildDefinition = isRecord(predicate)
    ? predicate["buildDefinition"]
    : undefined;
  const externalParameters = isRecord(buildDefinition)
    ? buildDefinition["externalParameters"]
    : undefined;
  const workflow = isRecord(externalParameters)
    ? externalParameters["workflow"]
    : undefined;
  return (
    statement["subject"].some(
      (subject) => isRecord(subject) && subject["name"] === expected.subject,
    ) &&
    isRecord(workflow) &&
    normalizeGitHubRepository(repositoryField(workflow["repository"])) ===
      expected.repository
  );
};

// npm is the trust anchor here: it verifies the registry signature, Sigstore
// root and signer identity, and binds the attestation subject digest to the
// published tarball. A pass needs npm's affirmative record of a verified
// provenance bundle for this exact version, and that same bundle must name the
// declared source repository.
const verifyPackageWithNpm = async ({
  name,
  version,
  expected,
  registry,
  timeoutMs,
  npmRunner,
}: {
  name: string;
  version: string;
  expected: ProvenanceExpectation;
  registry: string;
  timeoutMs: number;
  npmRunner: NpmRunner;
}): Promise<boolean> => {
  const directory = await mkdtemp(path.join(tmpdir(), "npm-provenance-"));
  const cache = path.join(directory, "cache");
  const env = { ...process.env, npm_config_cache: cache };
  try {
    await Bun.write(
      path.join(directory, "package.json"),
      JSON.stringify({ private: true, dependencies: { [name]: version } }),
    );
    const install = await npmRunner({
      args: [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry",
        registry,
      ],
      cwd: directory,
      env,
      timeoutMs,
    });
    if (install.exitCode !== 0) {
      return false;
    }
    const audit = await npmRunner({
      args: [
        "exec",
        "--yes",
        `npm@${NPM_AUDIT_VERSION}`,
        "--",
        "audit",
        "signatures",
        "--json",
        "--include-attestations",
        "--registry",
        registry,
      ],
      cwd: directory,
      env,
      timeoutMs,
    });
    if (audit.exitCode !== 0) {
      return false;
    }
    const report: unknown = JSON.parse(audit.stdout);
    if (
      !isRecord(report) ||
      !Array.isArray(report["invalid"]) ||
      !Array.isArray(report["missing"]) ||
      !Array.isArray(report["verified"])
    ) {
      return false;
    }
    const targetMatches = (entry: unknown) =>
      packageEntryMatches(entry, name, version);
    if (
      report["invalid"].length > 0 ||
      report["missing"].some(targetMatches) ||
      !report["verified"].some(
        (entry) =>
          targetMatches(entry) &&
          isRecord(entry) &&
          Array.isArray(entry["attestationBundles"]) &&
          entry["attestationBundles"].some((bundle) =>
            statementMatches(bundle, expected),
          ),
      )
    ) {
      return false;
    }
    const installed: unknown = await Bun.file(
      path.join(directory, "node_modules", name, "package.json"),
    ).json();
    return packageEntryMatches(installed, name, version);
  } catch {
    return false;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

type CheckRegistryOptions = {
  name: string;
  version: string;
  /** The allow-listed repository this package's releases moved to, if any. */
  movedRepository: string | undefined;
  bumpedAt: number | undefined;
  now: number;
  registry: string;
  timeoutMs: number;
  npmRunner?: NpmRunner;
  fetchImpl?: RegistryFetch;
};

export type RegistryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// This is the network boundary: exceptions become fixed, credential-free reasons.
export const checkRegistry = async ({
  name,
  version,
  bumpedAt,
  now,
  registry,
  timeoutMs,
  movedRepository,
  npmRunner = runNpm,
  fetchImpl = fetch,
}: CheckRegistryOptions): Promise<RegistryCheckResult> => {
  try {
    const response = await fetchImpl(
      `${registry.replace(/\/$/u, "")}/${encodeURIComponent(name)}/latest`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!response.ok) {
      return { status: "failed", reason: "http_status" };
    }
    const payload: unknown = await response.json();
    if (
      !isRecord(payload) ||
      typeof payload["version"] !== "string" ||
      !SEMVER.test(payload["version"])
    ) {
      return { status: "failed", reason: "contract_error" };
    }
    const npmRepository = normalizeGitHubRepository(
      repositoryField(payload["repository"]),
    );
    // Only an allow-listed move takes the provenance path, and only when npm
    // declares exactly that repository; any other declaration is judged by
    // the exact version comparison below, as before the move.
    if (movedRepository !== undefined && npmRepository === movedRepository) {
      const verified = await verifyPackageWithNpm({
        name,
        version: payload["version"],
        expected: {
          subject: `pkg:npm/${name
            .split("/")
            .map(encodeURIComponent)
            .join("/")}@${payload["version"]}`,
          repository: movedRepository,
        },
        registry,
        timeoutMs,
        npmRunner,
      });
      return verified
        ? { status: "passed", reason: "published_from_declared_repository" }
        : { status: "failed", reason: "unattested_publish" };
    }
    const assessment = comparePublishedVersion({
      latest: payload["version"],
      target: version,
      policy: PUBLISHED_VERSION_POLICY.journey,
      bumpedAt,
      now,
    });
    switch (assessment) {
      case "current":
        return { status: "passed", reason: "ok" };
      case "pending":
        return { status: "skipped", reason: "publish_pending" };
      case "mismatch":
        return {
          status: "failed",
          reason: "version_mismatch",
          latest: payload["version"],
        };
      default: {
        assessment satisfies never;
        throw new NpmPublishLagError("Unhandled version assessment");
      }
    }
  } catch (error) {
    return {
      status: "failed",
      reason:
        error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError")
          ? "timeout"
          : "contract_error",
    };
  }
};

// A release target carries its promotion time, never a main bump timestamp.
type PromotedPackage = {
  version: string;
  promotedAt: number;
};

export type RegistryResult =
  | RegistryCheckResult
  | PromotedRegistryResult
  | { status: "failed"; reason: "promotion_unavailable" };

type PromotedRegistryResult =
  | { status: "passed"; reason: "published" }
  | { status: "skipped"; reason: "pending_release" }
  | { status: "skipped"; reason: "publish_pending" }
  | { status: "failed"; reason: "publish_lagging"; latest: string };

type CheckPromotedRegistryOptions = Omit<
  CheckRegistryOptions,
  "version" | "bumpedAt" | "movedRepository"
> & {
  mainVersion: string;
  promotion: PromotedPackage;
};

export const checkPromotedRegistry = async ({
  mainVersion,
  promotion,
  ...options
}: CheckPromotedRegistryOptions): Promise<RegistryResult> => {
  const result = await checkRegistry({
    ...options,
    version: promotion.version,
    bumpedAt: undefined,
    movedRepository: undefined,
  });
  switch (result.reason) {
    case "ok":
      return Bun.semver.order(mainVersion, promotion.version) > 0
        ? { status: "skipped", reason: "pending_release" }
        : { status: "passed", reason: "published" };
    case "version_mismatch":
      // A newer published release also fulfills the promoted minimum.
      if (Bun.semver.order(result.latest, promotion.version) > 0) {
        return Bun.semver.order(mainVersion, promotion.version) > 0
          ? { status: "skipped", reason: "pending_release" }
          : { status: "passed", reason: "published" };
      }
      return promotion.promotedAt <= options.now &&
        options.now - promotion.promotedAt < DAY_SECONDS
        ? { status: "skipped", reason: "publish_pending" }
        : {
            status: "failed",
            reason: "publish_lagging",
            latest: result.latest,
          };
    case "http_status":
    case "timeout":
    case "contract_error":
    case "unattested_publish":
    case "published_from_declared_repository":
    case "publish_pending":
      return result;
    default: {
      result satisfies never;
      throw new NpmPublishLagError("Unhandled promoted registry assessment");
    }
  }
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
  if (
    comparePublishedVersion({
      latest,
      target: pkg.version,
      policy: PUBLISHED_VERSION_POLICY.release,
    }) === "current"
  ) {
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

type ReadPackageManifestOptions = {
  directory: string;
  text: string | undefined;
  policy: "release" | "journey";
};

export const readPackageManifest = ({
  directory,
  text,
  policy,
}: ReadPackageManifestOptions): PublishablePackage | undefined => {
  if (text === undefined) {
    if (policy === "journey") {
      return fail(`packages/${directory}/package.json is absent`);
    }
    return undefined;
  }
  const manifest: unknown = JSON.parse(text);
  if (
    !isRecord(manifest) ||
    typeof manifest["name"] !== "string" ||
    typeof manifest["version"] !== "string"
  ) {
    return fail(`packages/${directory}/package.json has no name or version`);
  }
  if (policy === "release" && manifest["private"] === true) {
    return undefined;
  }
  if (
    policy === "journey" &&
    (manifest["name"] !== `@stll/${directory}` ||
      !SEMVER.test(manifest["version"]))
  ) {
    return fail(
      `packages/${directory}/package.json has an invalid name or version`,
    );
  }
  return {
    directory,
    name: manifest["name"],
    version: manifest["version"],
  };
};

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
    const pkg = readPackageManifest({
      directory,
      text: readManifest(directory),
      policy: "release",
    });
    return pkg === undefined ? [] : [pkg];
  });
};

/** The newest stable `vX.Y.Z` tag among those listed, newest first. */
export const newestStableTag = (tags: readonly string[]): string | undefined =>
  tags.find((tag) => STABLE_RELEASE_TAG.test(tag));

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

const RFC_3339_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/u;

type PromotedRelease = { ref: string; promotedAt: number };

type PromotionSelection =
  | {
      status: "resolved";
      ref: string;
      promotedAt: number;
      promotions: readonly PromotedRelease[];
    }
  | { status: "invalid"; message: string }
  | { status: "missing"; message: string }
  | { status: "ambiguous"; message: string };

const parsePublicationTime = (value: string): number | null => {
  const match = RFC_3339_DATE_TIME_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return null;
  }
  if (
    (offsetHour !== undefined && Number(offsetHour) > 23) ||
    (offsetMinute !== undefined && Number(offsetMinute) > 59)
  ) {
    return null;
  }

  const calendarTime = new Date(0);
  calendarTime.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  calendarTime.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  if (
    calendarTime.toISOString().slice(0, 19) !==
    `${year}-${month}-${day}T${hour}:${minute}:${second}`
  ) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// Shared by the offline release resolver and the live registry journey.
export const selectPromotedRelease = (
  manifest: unknown,
): PromotionSelection => {
  if (!isRecord(manifest)) {
    return {
      status: "invalid",
      message: "The release publication manifest must be an object.",
    };
  }

  const promoted: {
    ref: string;
    publishedAt: string;
    publishedAtMs: number;
  }[] = [];
  for (const [ref, publishedAt] of Object.entries(manifest)) {
    if (ref === "_note") {
      continue;
    }
    if (!STABLE_RELEASE_TAG.test(ref)) {
      return {
        status: "invalid",
        message: `The release publication manifest contains an invalid stable release ref: ${ref}.`,
      };
    }
    if (publishedAt === null) {
      continue;
    }
    if (typeof publishedAt !== "string") {
      return {
        status: "invalid",
        message: `The release publication manifest contains an invalid publication time for ${ref}.`,
      };
    }
    const publishedAtMs = parsePublicationTime(publishedAt);
    if (publishedAtMs === null) {
      return {
        status: "invalid",
        message: `The release publication manifest contains an invalid publication time for ${ref}.`,
      };
    }
    promoted.push({ ref, publishedAt, publishedAtMs });
  }

  if (promoted.length === 0) {
    return {
      status: "missing",
      message: "The release publication manifest records no promoted release.",
    };
  }

  const ordered = promoted.toSorted(
    (left, right) => right.publishedAtMs - left.publishedAtMs,
  );
  const latest = ordered.at(0);
  if (!latest) {
    return {
      status: "missing",
      message: "The release publication manifest records no promoted release.",
    };
  }
  const candidates = ordered.filter(
    ({ publishedAtMs }) => publishedAtMs === latest.publishedAtMs,
  );
  if (candidates.length !== 1) {
    return {
      status: "ambiguous",
      message: `The release publication manifest records multiple releases at ${latest.publishedAt}: ${candidates.map(({ ref }) => ref).join(", ")}.`,
    };
  }

  return {
    status: "resolved",
    ref: latest.ref,
    promotedAt: latest.publishedAtMs / 1000,
    promotions: ordered.map(({ ref, publishedAtMs }) => ({
      ref,
      promotedAt: publishedAtMs / 1000,
    })),
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
