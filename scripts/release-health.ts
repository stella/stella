// Post-release regression check and the promote gate that reads its verdict.
//
// After a production promotion, `release-health.yml` waits out the window,
// queries the release's failure counts (`release_failure_window` events,
// see apps/api/src/lib/observability/release-failures.ts) next to the
// previous release's, and records a verdict on the GitHub release. The next
// promotion's gate refuses while the previous release is unhealthy,
// inconclusive or still inside its window, unless the dispatch acknowledges
// that release by name.
//
// Evaluation and gating use files and flags; private record commands call
// GitHub through the repository's retry wrapper. Its only
// package import is a type, so the workflows run it without an install.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import type { FailureReason } from "@stll/errors";

import {
  RELEASE_ENVIRONMENT_PROPERTY,
  RELEASE_FAILURE_ENTRY_KINDS,
  RELEASE_FAILURE_EVENT,
  RELEASE_FAILURE_FINGERPRINT_KEYS,
  RELEASE_VERSION_PROPERTY,
  type ReleaseFailureEntryKind,
  type ReleaseFailureEventProperties,
} from "../apps/api/src/lib/observability/release-failure-contract";

/** How long a promoted release runs before its verdict. */
const RELEASE_HEALTH_WINDOW_MINUTES = 60;
/** How long the gate waits for a verdict after the window closes. */
const VERDICT_GRACE_MINUTES = 30;
/** A fingerprint the previous release never produced must reach this count. */
const NEW_FINGERPRINT_MIN_OCCURRENCES = 3;
/** How far back the previous release's fingerprints are read. */
const BASELINE_LOOKBACK_DAYS = 14;
/**
 * Production events name their deployment environment from this instant on.
 * A baseline release whose window closed earlier recorded none.
 */
const ENVIRONMENT_RECORDED_SINCE = "2026-10-29T04:34:50Z";
/** Rows a result may hold; a full result may have dropped some. */
const QUERY_ROW_LIMIT = 10_000;
export const RELEASE_HEALTH_ASSET = "release-health.json";

const UNCLASSIFIED_REASON = "unclassified" satisfies FailureReason;
const MINUTE_MS = 60_000;
const STABLE_RELEASE_REF = /^v(\d+)\.(\d+)\.(\d+)$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

class ReleaseHealthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseHealthError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// --- Releases -----------------------------------------------------------------

type SemVer = readonly [number, number, number];

const stableVersion = (ref: string): SemVer | undefined => {
  const match = STABLE_RELEASE_REF.exec(ref);
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const requireStableRef = (ref: string): string => {
  if (stableVersion(ref) === undefined) {
    throw new ReleaseHealthError(
      "Release ref is not a stable release ref (v1.2.3)",
    );
  }
  return ref;
};

const compareVersions = (left: SemVer, right: SemVer): number =>
  left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

/** The version the API reports for a release ref: the ref without its `v`. */
const releaseVersion = (ref: string): string => requireStableRef(ref).slice(1);

type PublishedRelease = {
  readonly tag: string;
  readonly publishedAt: string;
  /** The verdict asset's id, when the release has one. */
  readonly verdictAssetId: number | null;
};

const readPublishedRelease = (value: unknown): PublishedRelease | undefined => {
  if (
    !isRecord(value) ||
    value["draft"] !== false ||
    value["prerelease"] !== false ||
    typeof value["tag_name"] !== "string" ||
    stableVersion(value["tag_name"]) === undefined ||
    typeof value["published_at"] !== "string" ||
    !Array.isArray(value["assets"])
  ) {
    return undefined;
  }
  const asset = value["assets"].find(
    (candidate: unknown) =>
      isRecord(candidate) && candidate["name"] === RELEASE_HEALTH_ASSET,
  );
  return {
    tag: value["tag_name"],
    publishedAt: value["published_at"],
    verdictAssetId:
      isRecord(asset) && typeof asset["id"] === "number" ? asset["id"] : null,
  };
};

/**
 * The published stable release that precedes `release`, from the GitHub
 * releases list. Drafts, prereleases and other channels never count.
 */
export const previousRelease = (
  release: string,
  releases: unknown,
): PublishedRelease | null => {
  const current = stableVersion(requireStableRef(release));
  if (current === undefined || !Array.isArray(releases)) {
    throw new ReleaseHealthError("The releases list must be a JSON array");
  }
  let best: { release: PublishedRelease; version: SemVer } | null = null;
  for (const entry of releases) {
    const published = readPublishedRelease(entry);
    const version =
      published === undefined ? undefined : stableVersion(published.tag);
    if (
      published === undefined ||
      version === undefined ||
      compareVersions(version, current) >= 0
    ) {
      continue;
    }
    if (best === null || compareVersions(version, best.version) > 0) {
      best = { release: published, version };
    }
  }
  return best?.release ?? null;
};

const instantMs = (value: string): number => {
  const instant = Date.parse(value);
  if (!ISO_INSTANT.test(value) || !Number.isFinite(instant)) {
    throw new ReleaseHealthError("Timestamp is not a UTC ISO instant");
  }
  return instant;
};

/** When a release published at `publishedAt` leaves its window. */
export const windowEnd = (publishedAt: string): string =>
  new Date(
    instantMs(publishedAt) + RELEASE_HEALTH_WINDOW_MINUTES * MINUTE_MS,
  ).toISOString();

// --- Query --------------------------------------------------------------------

const QUERY_COLUMNS = [
  "release",
  "kind",
  ...RELEASE_FAILURE_FINGERPRINT_KEYS,
  "failure_reason",
  "occurrences",
] as const;

// Bound to the event's own type, so a renamed property fails to compile here.
type EventProperty = keyof Extract<
  ReleaseFailureEventProperties,
  { kind: "fingerprint" }
>;

type BaselineRelease = {
  readonly ref: string;
  readonly publishedAt: string;
};

/**
 * Whether a baseline release's events name their environment. Only a
 * release whose window closed before environments were recorded is the
 * legacy case; every later release is read for production alone.
 */
export const baselineEnvironment = ({
  publishedAt,
}: BaselineRelease): "recorded" | "unrecorded" =>
  instantMs(windowEnd(publishedAt)) < instantMs(ENVIRONMENT_RECORDED_SINCE)
    ? "unrecorded"
    : "recorded";

type QueryOptions = {
  readonly release: string;
  readonly previous: BaselineRelease | null;
  /** The window's end: later events do not count. */
  readonly until: string;
};

/**
 * The HogQL request for both releases' counts. Values travel as
 * placeholders, never spliced into the query text.
 */
export const buildQuery = ({ release, previous, until }: QueryOptions) => {
  instantMs(until);
  const versions = previous === null ? [release] : [release, previous.ref];
  const versionPlaceholders = versions.map((_, index) => `{version_${index}}`);
  const property = (
    key:
      | EventProperty
      | typeof RELEASE_VERSION_PROPERTY
      | typeof RELEASE_ENVIRONMENT_PROPERTY,
  ): string => `properties.${key}`;
  const select = [
    `${property(RELEASE_VERSION_PROPERTY)} AS release`,
    `${property("kind")} AS kind`,
    ...RELEASE_FAILURE_FINGERPRINT_KEYS.map(
      (key) => `${property(key)} AS ${key}`,
    ),
    `${property("failure_reason")} AS failure_reason`,
    `sum(toInt(${property("occurrences")})) AS occurrences`,
  ];
  const query = [
    `SELECT ${select.join(", ")}`,
    "FROM events",
    "WHERE event = {event}",
    // A legacy baseline's events carry no environment; they count toward
    // that baseline only, never as the checked release's own failures.
    previous !== null && baselineEnvironment(previous) === "unrecorded"
      ? `AND (${property(RELEASE_ENVIRONMENT_PROPERTY)} = {environment} OR (${property(RELEASE_ENVIRONMENT_PROPERTY)} IS NULL AND ${property(RELEASE_VERSION_PROPERTY)} = {version_1}))`
      : `AND ${property(RELEASE_ENVIRONMENT_PROPERTY)} = {environment}`,
    `AND ${property(RELEASE_VERSION_PROPERTY)} IN (${versionPlaceholders.join(", ")})`,
    "AND timestamp < toDateTime({until})",
    `AND timestamp >= toDateTime({until}) - INTERVAL ${BASELINE_LOOKBACK_DAYS} DAY`,
    `GROUP BY ${QUERY_COLUMNS.slice(0, -1).join(", ")}`,
    `LIMIT ${QUERY_ROW_LIMIT}`,
  ].join("\n");
  const values: Record<string, string> = {
    event: RELEASE_FAILURE_EVENT,
    environment: "production",
    until,
    ...Object.fromEntries(
      versions.map((ref, index) => [`version_${index}`, releaseVersion(ref)]),
    ),
  };
  return { query: { kind: "HogQLQuery", query, values } };
};

// --- Result -------------------------------------------------------------------

type Fingerprint = {
  readonly handler: string;
  readonly errorClass: string;
  readonly errorCode: string;
};

type FailureRow =
  | {
      readonly kind: "fingerprint";
      readonly release: string;
      readonly fingerprint: Fingerprint;
      readonly reason: string;
      readonly occurrences: number;
    }
  | {
      readonly kind: "overflow";
      readonly release: string;
      readonly occurrences: number;
    };

const ENTRY_KINDS: ReadonlySet<string> = new Set(RELEASE_FAILURE_ENTRY_KINDS);

const isEntryKind = (value: unknown): value is ReleaseFailureEntryKind =>
  typeof value === "string" && ENTRY_KINDS.has(value);

const readRow = (row: unknown): FailureRow | undefined => {
  if (!Array.isArray(row) || row.length !== QUERY_COLUMNS.length) {
    return undefined;
  }
  const [release, kind, handler, errorClass, errorCode, reason, occurrences] =
    row;
  if (
    typeof release !== "string" ||
    !isEntryKind(kind) ||
    typeof occurrences !== "number" ||
    !Number.isSafeInteger(occurrences) ||
    occurrences < 0
  ) {
    return undefined;
  }
  switch (kind) {
    case "overflow":
      return { kind, release, occurrences };
    case "fingerprint":
      if (
        typeof handler !== "string" ||
        typeof errorClass !== "string" ||
        typeof errorCode !== "string" ||
        typeof reason !== "string"
      ) {
        return undefined;
      }
      return {
        kind,
        release,
        fingerprint: { handler, errorClass, errorCode },
        reason,
        occurrences,
      };
    default:
      kind satisfies never;
      throw new ReleaseHealthError("Unhandled release failure entry kind");
  }
};

type ParsedResult =
  | { readonly type: "rows"; readonly rows: readonly FailureRow[] }
  | {
      readonly type: "invalid";
      readonly cause: "result_invalid" | "result_truncated";
    };

/** Read a HogQL response, refusing anything but the columns asked for. */
const parseQueryResult = (response: unknown): ParsedResult => {
  if (
    !isRecord(response) ||
    !Array.isArray(response["results"]) ||
    !Array.isArray(response["columns"]) ||
    response["columns"].join(",") !== QUERY_COLUMNS.join(",")
  ) {
    return { type: "invalid", cause: "result_invalid" };
  }
  if (response["results"].length >= QUERY_ROW_LIMIT) {
    return { type: "invalid", cause: "result_truncated" };
  }
  const rows: FailureRow[] = [];
  for (const raw of response["results"]) {
    const row = readRow(raw);
    if (row === undefined) {
      return { type: "invalid", cause: "result_invalid" };
    }
    rows.push(row);
  }
  return { type: "rows", rows };
};

// --- Findings -----------------------------------------------------------------

type ReleaseFinding =
  | {
      readonly type: "unclassified";
      readonly fingerprint: Fingerprint;
      readonly occurrences: number;
    }
  | {
      readonly type: "new_fingerprint";
      readonly fingerprint: Fingerprint;
      readonly occurrences: number;
    }
  | { readonly type: "overflow"; readonly occurrences: number };

const FINDING_TYPES = {
  unclassified: true,
  new_fingerprint: true,
  overflow: true,
} as const satisfies Record<ReleaseFinding["type"], boolean>;

const isFindingType = (value: unknown): value is ReleaseFinding["type"] =>
  typeof value === "string" && Object.hasOwn(FINDING_TYPES, value);

const fingerprintKey = ({ handler, errorClass, errorCode }: Fingerprint) =>
  JSON.stringify([handler, errorClass, errorCode]);

type FindingsInput = {
  readonly rows: readonly FailureRow[];
  readonly release: string;
  /** The previous stable release, or null when this is the first one. */
  readonly baselineRelease: string | null;
};

/**
 * What the release did that the previous one did not: any unclassified
 * failure at all, a fingerprint the previous release never produced at or
 * above the threshold, and failures that found the window's fingerprint
 * budget spent at or above the threshold. Rows of neither release are
 * ignored. Without a previous release there is no baseline, so no
 * fingerprint is new; a previous release without failures is a baseline in
 * which every fingerprint is new.
 */
const findRegressions = ({
  rows,
  release,
  baselineRelease,
}: FindingsInput): ReleaseFinding[] => {
  const version = releaseVersion(release);
  const previousVersion =
    baselineRelease === null ? null : releaseVersion(baselineRelease);
  const previous = new Set<string>();
  const current = new Map<
    string,
    { fingerprint: Fingerprint; occurrences: number }
  >();
  const findings: ReleaseFinding[] = [];
  let overflow = 0;
  for (const row of rows) {
    if (row.kind === "overflow") {
      overflow += row.release === version ? row.occurrences : 0;
      continue;
    }
    const key = fingerprintKey(row.fingerprint);
    if (row.release !== version) {
      if (row.release === previousVersion) {
        previous.add(key);
      }
      continue;
    }
    if (row.reason === UNCLASSIFIED_REASON && row.occurrences > 0) {
      findings.push({
        type: "unclassified",
        fingerprint: row.fingerprint,
        occurrences: row.occurrences,
      });
    }
    const counted = current.get(key);
    current.set(key, {
      fingerprint: row.fingerprint,
      occurrences: (counted?.occurrences ?? 0) + row.occurrences,
    });
  }
  for (const [key, { fingerprint, occurrences }] of current) {
    if (
      previousVersion !== null &&
      !previous.has(key) &&
      occurrences >= NEW_FINGERPRINT_MIN_OCCURRENCES
    ) {
      findings.push({ type: "new_fingerprint", fingerprint, occurrences });
    }
  }
  if (overflow >= NEW_FINGERPRINT_MIN_OCCURRENCES) {
    findings.push({ type: "overflow", occurrences: overflow });
  }
  return findings;
};

// --- Verdict ------------------------------------------------------------------

const INCONCLUSIVE_CAUSES = [
  "query_failed",
  "result_invalid",
  "result_truncated",
] as const;

type InconclusiveCause = (typeof INCONCLUSIVE_CAUSES)[number];

type ReleaseHealthVerdict =
  | {
      readonly verdict: "healthy";
      readonly release: string;
      readonly checkedAt: string;
    }
  | {
      readonly verdict: "unhealthy";
      readonly release: string;
      readonly checkedAt: string;
      readonly findings: number;
    }
  | {
      readonly verdict: "inconclusive";
      readonly release: string;
      readonly checkedAt: string;
      readonly cause: InconclusiveCause;
    };

type EvaluateOptions = {
  readonly release: string;
  /** The release the query compared against, or null when there is none. */
  readonly baselineRelease: string | null;
  /** The HogQL response, or null when the query itself failed. */
  readonly response: unknown;
  readonly checkedAt: string;
};

type Evaluation = {
  readonly verdict: ReleaseHealthVerdict;
  readonly findings: readonly ReleaseFinding[];
};

export const evaluateRelease = ({
  release,
  baselineRelease,
  response,
  checkedAt,
}: EvaluateOptions): Evaluation => {
  if (response === null) {
    return {
      verdict: {
        verdict: "inconclusive",
        release,
        checkedAt,
        cause: "query_failed",
      },
      findings: [],
    };
  }
  const parsed = parseQueryResult(response);
  switch (parsed.type) {
    case "invalid":
      return {
        verdict: {
          verdict: "inconclusive",
          release,
          checkedAt,
          cause: parsed.cause,
        },
        findings: [],
      };
    case "rows": {
      const findings = findRegressions({
        rows: parsed.rows,
        release,
        baselineRelease,
      });
      return {
        verdict:
          findings.length === 0
            ? { verdict: "healthy", release, checkedAt }
            : {
                verdict: "unhealthy",
                release,
                checkedAt,
                findings: findings.length,
              },
        findings,
      };
    }
    default:
      parsed satisfies never;
      throw new ReleaseHealthError("Unhandled query result");
  }
};

/** Public output contains only the verdict, count and opaque record reference. */
export const summarize = ({ verdict, findings }: Evaluation): string =>
  `### Release health: ${verdict.release} is ${verdict.verdict}\n\nFindings: ${findings.length}\nRecord: ${recordReference(verdict.release)}\n`;

const recordReference = (release: string): string =>
  `release-health:${requireStableRef(release)}`;

const findingCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ReleaseHealthError("Invalid release health finding count");
  }
  return value;
};

type PublicRecord = {
  readonly verdict: ReleaseHealthVerdict;
  readonly details:
    | { readonly type: "unknown" }
    | {
        readonly type: "private";
        readonly reference: string;
        readonly count: number;
      };
};

/** Count-only assets are persisted data; their detail availability is unknown. */
export const readPublicRecord = (value: unknown): PublicRecord => {
  if (
    !isRecord(value) ||
    typeof value["release"] !== "string" ||
    typeof value["checkedAt"] !== "string"
  ) {
    throw new ReleaseHealthError("Invalid release health verdict");
  }
  const release = requireStableRef(value["release"]);
  const checkedAt = value["checkedAt"];
  instantMs(checkedAt);
  let verdict: ReleaseHealthVerdict;
  switch (value["verdict"]) {
    case "healthy":
      verdict = { verdict: "healthy", release, checkedAt };
      break;
    case "unhealthy":
      verdict = {
        verdict: "unhealthy",
        release,
        checkedAt,
        findings: findingCount(value["findings"]),
      };
      break;
    case "inconclusive": {
      const cause = INCONCLUSIVE_CAUSES.find(
        (candidate) => candidate === value["cause"],
      );
      if (cause === undefined) {
        throw new ReleaseHealthError("Invalid release health cause");
      }
      verdict = { verdict: "inconclusive", release, checkedAt, cause };
      break;
    }
    default:
      throw new ReleaseHealthError("Invalid release health verdict");
  }
  if (value["record"] === undefined) {
    return { verdict, details: { type: "unknown" } };
  }
  if (value["record"] !== recordReference(release)) {
    throw new ReleaseHealthError("Invalid release health reference");
  }
  const count = findingCount(value["findings"]);
  if (verdict.verdict !== "unhealthy" && count !== 0) {
    throw new ReleaseHealthError("Unexpected release health findings");
  }
  return {
    verdict,
    details: { type: "private", reference: recordReference(release), count },
  };
};

type PrivateRecord = {
  readonly version: 1;
  readonly verdict: ReleaseHealthVerdict;
  readonly baseline: {
    readonly release: string;
    readonly environment: ReturnType<typeof baselineEnvironment>;
  } | null;
  /** Snapshot the environment predicate and bindings used for this baseline. */
  readonly query: ReturnType<typeof buildQuery>["query"];
  readonly window: {
    readonly start: string;
    readonly end: string;
    readonly baselineLookbackDays: number;
  };
  readonly findings: readonly ReleaseFinding[];
};

const readStoredQuery = (value: unknown): PrivateRecord["query"] => {
  if (
    !isRecord(value) ||
    value["kind"] !== "HogQLQuery" ||
    typeof value["query"] !== "string" ||
    !isRecord(value["values"])
  ) {
    throw new ReleaseHealthError("Invalid private release health query");
  }
  const values = Object.fromEntries(
    Object.entries(value["values"]).map(([key, binding]) => {
      if (typeof binding !== "string") {
        throw new ReleaseHealthError(
          "Invalid private release health query binding",
        );
      }
      return [key, binding] as const;
    }),
  );
  return { kind: "HogQLQuery", query: value["query"], values };
};

export const readPrivateRecord = (value: unknown): PrivateRecord => {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    !Array.isArray(value["findings"]) ||
    !isRecord(value["window"]) ||
    !(value["baseline"] === null || isRecord(value["baseline"]))
  ) {
    throw new ReleaseHealthError("Invalid private release health record");
  }
  const { verdict } = readPublicRecord(value["verdict"]);
  const rawBaseline = value["baseline"];
  let baseline: PrivateRecord["baseline"] = null;
  if (rawBaseline !== null) {
    if (
      !isRecord(rawBaseline) ||
      typeof rawBaseline["release"] !== "string" ||
      (rawBaseline["environment"] !== "recorded" &&
        rawBaseline["environment"] !== "unrecorded")
    ) {
      throw new ReleaseHealthError("Invalid private release health baseline");
    }
    baseline = {
      release: requireStableRef(rawBaseline["release"]),
      environment: rawBaseline["environment"],
    };
  }
  const query = readStoredQuery(value["query"]);
  const window = value["window"];
  if (
    typeof window["start"] !== "string" ||
    typeof window["end"] !== "string" ||
    window["baselineLookbackDays"] !== BASELINE_LOOKBACK_DAYS ||
    windowEnd(window["start"]) !==
      new Date(instantMs(window["end"])).toISOString()
  ) {
    throw new ReleaseHealthError("Invalid private release health window");
  }
  const findings: ReleaseFinding[] = [];
  for (const finding of value["findings"]) {
    if (!isRecord(finding)) {
      throw new ReleaseHealthError("Invalid private release finding");
    }
    const occurrences = findingCount(finding["occurrences"]);
    const findingType = finding["type"];
    if (!isFindingType(findingType)) {
      throw new ReleaseHealthError("Invalid private release finding type");
    }
    switch (findingType) {
      case "overflow":
        findings.push({ type: "overflow", occurrences });
        break;
      case "unclassified":
      case "new_fingerprint": {
        const fingerprint = finding["fingerprint"];
        if (
          !isRecord(fingerprint) ||
          typeof fingerprint["handler"] !== "string" ||
          typeof fingerprint["errorClass"] !== "string" ||
          typeof fingerprint["errorCode"] !== "string"
        ) {
          throw new ReleaseHealthError("Invalid private release fingerprint");
        }
        findings.push({
          type: findingType,
          occurrences,
          fingerprint: {
            handler: fingerprint["handler"],
            errorClass: fingerprint["errorClass"],
            errorCode: fingerprint["errorCode"],
          },
        });
        break;
      }
      default:
        findingType satisfies never;
        throw new ReleaseHealthError("Unhandled private release finding type");
    }
  }
  if (
    findings.length !== (verdict.verdict === "unhealthy" ? verdict.findings : 0)
  ) {
    throw new ReleaseHealthError("Private release finding count mismatch");
  }
  return {
    version: 1,
    verdict,
    baseline,
    query,
    window: {
      start: window["start"],
      end: window["end"],
      baselineLookbackDays: BASELINE_LOOKBACK_DAYS,
    },
    findings,
  };
};

const STORE_RELEASE = "release-health-v1";
const DEFAULT_STORE = "stella/stella-infra";

// Never echo API response bodies on failure: even errors can contain private data.
const github = (args: readonly string[]): string => {
  const result = Bun.spawnSync(
    ["bash", path.join(import.meta.dir, "gh-retry.sh"), ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new ReleaseHealthError(
      "Private release record request failed: the draft store or tag record is missing or inaccessible. Draft reads require a token with contents:write (GitHub returns 404 for insufficient access).",
    );
  }
  return result.stdout.toString();
};

const requirePrivateStore = (store: string): void => {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(store) ||
    github(["api", `repos/${store}`, "--jq", ".private"]).trim() !== "true"
  ) {
    throw new ReleaseHealthError(
      "Release health store must be a private repository",
    );
  }
  const metadata: unknown = JSON.parse(
    github([
      "release",
      "view",
      STORE_RELEASE,
      "--repo",
      store,
      "--json",
      "isDraft",
    ]),
  );
  if (!isRecord(metadata) || metadata["isDraft"] !== true) {
    throw new ReleaseHealthError(
      "Release health store must remain a draft release",
    );
  }
};

type ReadStoredRecordOptions = {
  readonly release: string;
  readonly store: string;
};

const readStoredRecord = ({
  release,
  store,
}: ReadStoredRecordOptions): PrivateRecord => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-health-read-"));
  try {
    github([
      "release",
      "download",
      STORE_RELEASE,
      "--repo",
      store,
      "--pattern",
      `${release}.json`,
      "--dir",
      directory,
    ]);
    const record = readPrivateRecordFile(
      path.join(directory, `${release}.json`),
    );
    if (record.verdict.release !== release) {
      throw new ReleaseHealthError("Private record names another release");
    }
    return record;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

// --- Gate ---------------------------------------------------------------------

type GateDecision =
  | {
      readonly type: "pass";
      readonly reason:
        "no_previous_release" | "healthy" | "acknowledged" | "no_verdict";
    }
  | {
      readonly type: "refuse";
      readonly reason: "unhealthy" | "inconclusive" | "window_open";
    };

type GateOptions = {
  readonly previous: PublishedRelease | null;
  /** The previous release's recorded verdict file, when it has one. */
  readonly verdict: unknown;
  /** The release ref the dispatch acknowledged, or "" when none. */
  readonly acknowledged: string;
  readonly now: string;
};

/**
 * Whether the next promotion may proceed. An unhealthy or inconclusive
 * previous release blocks it until a dispatch names that release, and a
 * release still inside its window (plus the time its check needs) blocks it
 * until the verdict exists. A release without a verdict past that point
 * predates the check: its absence was already alerted as a failed run.
 */
export const gatePromotion = ({
  previous,
  verdict,
  acknowledged,
  now,
}: GateOptions): GateDecision => {
  if (previous === null) {
    return { type: "pass", reason: "no_previous_release" };
  }
  if (verdict === null) {
    const closesAt =
      instantMs(previous.publishedAt) +
      (RELEASE_HEALTH_WINDOW_MINUTES + VERDICT_GRACE_MINUTES) * MINUTE_MS;
    return instantMs(now) < closesAt
      ? { type: "refuse", reason: "window_open" }
      : { type: "pass", reason: "no_verdict" };
  }
  if (!isRecord(verdict) || verdict["release"] !== previous.tag) {
    throw new ReleaseHealthError(
      `${RELEASE_HEALTH_ASSET} on ${previous.tag} names another release`,
    );
  }
  const recorded = readPublicRecord(verdict).verdict.verdict;
  switch (recorded) {
    case "healthy":
      return { type: "pass", reason: "healthy" };
    case "unhealthy":
    case "inconclusive":
      return acknowledged === previous.tag
        ? { type: "pass", reason: "acknowledged" }
        : { type: "refuse", reason: recorded };
    default:
      recorded satisfies never;
      throw new ReleaseHealthError("Unhandled verdict");
  }
};

const describeGate = (
  decision: GateDecision,
  previous: PublishedRelease | null,
): string => {
  const tag = previous?.tag ?? "none";
  switch (decision.reason) {
    case "no_previous_release":
      return "No previous stable release; nothing to gate on.";
    case "healthy":
      return `${tag} passed its post-release check.`;
    case "acknowledged":
      return `${tag} did not pass its post-release check; the dispatch acknowledged it.`;
    case "no_verdict":
      return `${tag} has no post-release verdict; it predates the check.`;
    case "unhealthy":
    case "inconclusive":
      return `${tag} is ${decision.reason} after its post-release check. Read findings with: bun scripts/release-health.ts findings --release ${tag}. Investigate, then re-dispatch Release Artifacts with acknowledge_unhealthy_release=${tag}.`;
    case "window_open":
      return `${tag} is still inside its post-release window. Wait for its verdict, or re-dispatch Release Artifacts with acknowledge_unhealthy_release=${tag}.`;
    default:
      decision satisfies never;
      throw new ReleaseHealthError("Unhandled gate decision");
  }
};

// --- CLI ----------------------------------------------------------------------

const readJsonFile = (file: string): unknown =>
  JSON.parse(readFileSync(file, "utf-8"));

// The CLI's private-file boundary must not print JSON snippets or private values.
const readPrivateRecordFile = (file: string): PrivateRecord => {
  try {
    return readPrivateRecord(readJsonFile(file));
  } catch {
    throw new ReleaseHealthError(
      "Private release record is malformed or unreadable; inspect it in private storage",
    );
  }
};

const readOptionalJsonFile = (file: string | undefined): unknown => {
  if (file === undefined) {
    return null;
  }
  const text = readFileSync(file, "utf-8").trim();
  return text === "" ? null : JSON.parse(text);
};

/** What `previous` printed: a release, or null when there is none. */
const readPreviousRelease = (value: unknown): PublishedRelease | null => {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value["tag"] !== "string" ||
    stableVersion(value["tag"]) === undefined ||
    typeof value["publishedAt"] !== "string" ||
    !(
      value["verdictAssetId"] === null ||
      typeof value["verdictAssetId"] === "number"
    )
  ) {
    throw new ReleaseHealthError("The previous release file is malformed");
  }
  return {
    tag: value["tag"],
    publishedAt: value["publishedAt"],
    verdictAssetId: value["verdictAssetId"],
  };
};

const required = (value: string | undefined, flag: string): string => {
  if (value === undefined || value === "") {
    throw new ReleaseHealthError(`--${flag} is required`);
  }
  return value;
};

const optionalRef = (value: string | undefined): string | null =>
  value === undefined || value === "" ? null : requireStableRef(value);

const CLI_OPTIONS = {
  release: { type: "string" },
  previous: { type: "string" },
  releases: { type: "string" },
  "published-at": { type: "string" },
  "previous-published-at": { type: "string" },
  until: { type: "string" },
  now: { type: "string" },
  result: { type: "string" },
  verdict: { type: "string" },
  "previous-release": { type: "string" },
  acknowledged: { type: "string" },
  summary: { type: "string" },
  record: { type: "string" },
  store: { type: "string" },
} as const;

const USAGE =
  "usage: release-health.ts previous|window-end|query|evaluate|gate|findings|record [flags]";

const run = (argv: readonly string[]): number => {
  const { positionals, values } = parseArgs({
    args: [...argv],
    options: CLI_OPTIONS,
    allowPositionals: true,
  });
  const command = positionals.at(0);
  if (command === undefined) {
    throw new ReleaseHealthError(USAGE);
  }
  switch (command) {
    case "previous": {
      const previous = previousRelease(
        requireStableRef(required(values.release, "release")),
        readJsonFile(required(values.releases, "releases")),
      );
      process.stdout.write(`${JSON.stringify(previous)}\n`);
      return 0;
    }
    case "window-end": {
      process.stdout.write(
        `${windowEnd(required(values["published-at"], "published-at"))}\n`,
      );
      return 0;
    }
    case "query": {
      const previous = optionalRef(values.previous);
      const body = buildQuery({
        release: requireStableRef(required(values.release, "release")),
        previous:
          previous === null
            ? null
            : {
                ref: previous,
                publishedAt: required(
                  values["previous-published-at"],
                  "previous-published-at",
                ),
              },
        until: required(values.until, "until"),
      });
      process.stdout.write(`${JSON.stringify(body)}\n`);
      return 0;
    }
    case "evaluate": {
      const previousRef = optionalRef(values.previous);
      const previous =
        previousRef === null
          ? null
          : {
              ref: previousRef,
              publishedAt: required(
                values["previous-published-at"],
                "previous-published-at",
              ),
            };
      const evaluation = evaluateRelease({
        release: requireStableRef(required(values.release, "release")),
        baselineRelease: optionalRef(values.previous),
        response: readOptionalJsonFile(values.result),
        checkedAt: required(values.now, "now"),
      });
      const until = required(values.until, "until");
      const record = readPrivateRecord({
        version: 1,
        verdict: evaluation.verdict,
        baseline:
          previous === null
            ? null
            : {
                release: previous.ref,
                environment: baselineEnvironment(previous),
              },
        query: buildQuery({
          release: requireStableRef(required(values.release, "release")),
          previous,
          until,
        }).query,
        window: {
          start: new Date(
            instantMs(until) - RELEASE_HEALTH_WINDOW_MINUTES * MINUTE_MS,
          ).toISOString(),
          end: until,
          baselineLookbackDays: BASELINE_LOOKBACK_DAYS,
        },
        findings: evaluation.findings,
      });
      writeFileSync(
        required(values.record, "record"),
        `${JSON.stringify(record)}\n`,
        { mode: 0o600 },
      );
      writeFileSync(
        required(values.verdict, "verdict"),
        `${JSON.stringify({ ...evaluation.verdict, findings: evaluation.findings.length, record: recordReference(evaluation.verdict.release) })}\n`,
      );
      writeFileSync(
        required(values.summary, "summary"),
        summarize(evaluation),
        {
          flag: "a",
        },
      );
      return 0;
    }
    case "record":
    case "findings": {
      const release = requireStableRef(required(values.release, "release"));
      const store = values.store ?? DEFAULT_STORE;
      requirePrivateStore(store);
      if (command === "findings") {
        process.stdout.write(
          `${JSON.stringify(readStoredRecord({ release, store }), null, 2)}\n`,
        );
        return 0;
      }
      const record = readPrivateRecordFile(required(values.record, "record"));
      if (record.verdict.release !== release) {
        throw new ReleaseHealthError("Private record names another release");
      }
      const directory = mkdtempSync(
        path.join(tmpdir(), "release-health-record-"),
      );
      try {
        const file = path.join(directory, `${release}.json`);
        writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        github([
          "release",
          "upload",
          STORE_RELEASE,
          file,
          "--repo",
          store,
          "--clobber",
        ]);
        if (
          JSON.stringify(readStoredRecord({ release, store })) !==
          JSON.stringify(record)
        ) {
          throw new ReleaseHealthError(
            "Private release record readback mismatch",
          );
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      return 0;
    }
    case "gate": {
      const previous = readPreviousRelease(
        readJsonFile(required(values["previous-release"], "previous-release")),
      );
      const decision = gatePromotion({
        previous,
        verdict: readOptionalJsonFile(values.verdict),
        acknowledged: values.acknowledged ?? "",
        now: required(values.now, "now"),
      });
      const message = describeGate(decision, previous);
      switch (decision.type) {
        case "pass":
          process.stdout.write(`${message}\n`);
          return 0;
        case "refuse":
          process.stderr.write(`::error::${message}\n`);
          return 1;
        default:
          decision satisfies never;
          throw new ReleaseHealthError("Unhandled gate decision");
      }
    }
    default:
      throw new ReleaseHealthError(USAGE);
  }
};

if (import.meta.main) {
  process.exitCode = run(Bun.argv.slice(2));
}
