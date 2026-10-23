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
// Every subcommand is a pure function of its files and flags; the workflows
// make the network calls through the repository's retry wrappers. Its only
// package import is a type, so the workflows run it without an install.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import type { FailureReason } from "@stll/errors";

import {
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
    throw new ReleaseHealthError(`${ref} is not a stable release ref (v1.2.3)`);
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
  if (!ISO_INSTANT.test(value)) {
    throw new ReleaseHealthError(`${value} is not a UTC ISO instant`);
  }
  return Date.parse(value);
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

type QueryOptions = {
  readonly release: string;
  readonly previous: string | null;
  /** The window's end: later events do not count. */
  readonly until: string;
};

/**
 * The HogQL request for both releases' counts. Values travel as
 * placeholders, never spliced into the query text.
 */
export const buildQuery = ({ release, previous, until }: QueryOptions) => {
  instantMs(until);
  const versions = previous === null ? [release] : [release, previous];
  const versionPlaceholders = versions.map((_, index) => `{version_${index}}`);
  const property = (
    key: EventProperty | typeof RELEASE_VERSION_PROPERTY,
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
    `AND ${property(RELEASE_VERSION_PROPERTY)} IN (${versionPlaceholders.join(", ")})`,
    "AND timestamp < toDateTime({until})",
    `AND timestamp >= toDateTime({until}) - INTERVAL ${BASELINE_LOOKBACK_DAYS} DAY`,
    `GROUP BY ${QUERY_COLUMNS.slice(0, -1).join(", ")}`,
    `LIMIT ${QUERY_ROW_LIMIT}`,
  ].join("\n");
  const values: Record<string, string> = {
    event: RELEASE_FAILURE_EVENT,
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

const describeFingerprint = ({ handler, errorClass, errorCode }: Fingerprint) =>
  `\`${handler}\` ${errorClass} (${errorCode})`;

const describeFinding = (finding: ReleaseFinding): string => {
  switch (finding.type) {
    case "unclassified":
      return `unclassified failure: ${describeFingerprint(finding.fingerprint)}`;
    case "new_fingerprint":
      return `new failure fingerprint: ${describeFingerprint(finding.fingerprint)}`;
    case "overflow":
      return "failures beyond the per-window fingerprint budget";
    default:
      finding satisfies never;
      throw new ReleaseHealthError("Unhandled finding");
  }
};

/**
 * The step summary. Fingerprints only: counts stay in the analytics project,
 * because the repository and its run logs are public.
 */
export const summarize = ({ verdict, findings }: Evaluation): string => {
  const heading = `### Release health: ${verdict.release} is ${verdict.verdict}`;
  switch (verdict.verdict) {
    case "healthy":
      return `${heading}\n`;
    case "unhealthy":
      return [
        heading,
        "",
        ...findings.map((finding) => `- ${describeFinding(finding)}`),
        "",
      ].join("\n");
    case "inconclusive":
      return `${heading}\n\nCause: ${verdict.cause}\n`;
    default:
      verdict satisfies never;
      throw new ReleaseHealthError("Unhandled verdict");
  }
};

const VERDICTS: ReadonlySet<string> = new Set([
  "healthy",
  "unhealthy",
  "inconclusive",
]);

const readVerdict = (value: unknown): ReleaseHealthVerdict["verdict"] => {
  if (
    !isRecord(value) ||
    typeof value["verdict"] !== "string" ||
    !VERDICTS.has(value["verdict"])
  ) {
    throw new ReleaseHealthError(`${RELEASE_HEALTH_ASSET} is not a verdict`);
  }
  switch (value["verdict"]) {
    case "healthy":
    case "unhealthy":
    case "inconclusive":
      return value["verdict"];
    default:
      throw new ReleaseHealthError(`${RELEASE_HEALTH_ASSET} is not a verdict`);
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
  const recorded = readVerdict(verdict);
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
      return `${tag} is ${decision.reason} after its post-release check. Investigate, then re-dispatch Release Artifacts with acknowledge_unhealthy_release=${tag}.`;
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
  until: { type: "string" },
  now: { type: "string" },
  result: { type: "string" },
  verdict: { type: "string" },
  "previous-release": { type: "string" },
  acknowledged: { type: "string" },
  summary: { type: "string" },
} as const;

const USAGE =
  "usage: release-health.ts previous|window-end|query|evaluate|gate [flags]";

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
      const body = buildQuery({
        release: requireStableRef(required(values.release, "release")),
        previous: optionalRef(values.previous),
        until: required(values.until, "until"),
      });
      process.stdout.write(`${JSON.stringify(body)}\n`);
      return 0;
    }
    case "evaluate": {
      const evaluation = evaluateRelease({
        release: requireStableRef(required(values.release, "release")),
        baselineRelease: optionalRef(values.previous),
        response: readOptionalJsonFile(values.result),
        checkedAt: required(values.now, "now"),
      });
      writeFileSync(
        required(values.verdict, "verdict"),
        `${JSON.stringify(evaluation.verdict)}\n`,
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
