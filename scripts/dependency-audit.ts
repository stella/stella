// Dependency vulnerability guard.
//
// `bun audit` checks the lockfile against the npm advisory database and exits
// nonzero when it reports advisories, but an exit code cannot record why a
// known advisory is accepted or when that acceptance lapses, and it cannot
// limit a pull request to the dependency resolutions that it changed. This
// wraps it into a ratchet, mirroring scripts/bundle-baseline.ts: every current
// high/critical advisory is recorded in scripts/dependency-audit-baseline.json
// with a reason, and the --check mode fails only when a NEW high/critical
// advisory appears that is not in the baseline. Known-and-accepted advisories
// (transitive, non-reachable) are tracked, not silently ignored. A baselined
// advisory that is no longer reported only warns and flags the scheduled
// remediation, which opens a pull request removing the stale entry: an advisory
// disappearing is a state change, never a reason to fail main.
//
// This is a supply-chain complement to the 5-day `minimumReleaseAge` quarantine
// in bunfig.toml (which blocks freshly published — potentially malicious —
// versions at install time); this guard catches KNOWN vulnerabilities in the
// versions already resolved.
//
// Modes:
//   bun scripts/dependency-audit.ts                 report current high/critical advisories
//   bun scripts/dependency-audit.ts --assess        typed table and full-tree gate
//   bun scripts/dependency-audit.ts --check         full-tree gate: exit 1 on a new high/critical advisory
//   bun scripts/dependency-audit.ts --check-diff REF PR gate: audit only resolutions changed since REF
//   bun scripts/dependency-audit.ts --release       release gate: apply baseline with stricter acceptance metadata
//   bun scripts/dependency-audit.ts --write-baseline regenerate the baseline from the current audit
//   bun scripts/dependency-audit.ts --prune-baseline remove acceptances whose advisory is no longer reported
//   bun scripts/dependency-audit.ts --self-test     prove the comparison logic fires
//
// Every mode uses the same closed exit-code contract:
//   0 pass, 1 new advisory, 2 baseline problem, 3 audit failure,
//   4 unexpected error.
//
// A baseline entry may be temporary: `expiresOn` and `untilPatched` make the
// acceptance lapse when its owning file changes after expiry, or once a
// patched release is published; routine date expiry warns. See
// scripts/dependency-audit-acceptance.ts.

import { panic, Result } from "better-result";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";
import { repoRelativePath } from "@stll/portable-path";

import { BASELINE_PATHS } from "./baseline-paths";
import {
  expiringAcceptances,
  type LapsedAcceptance,
  lapsedAcceptances,
  type LatestInstallableRelease,
  patchedAcceptanceWindows,
} from "./dependency-audit-acceptance";
import {
  assessAdvisories,
  AuditAssessmentError,
  printAssessments,
  readInstallableReleases,
  readInstallableVersions,
  readReleaseAgePolicy,
} from "./dependency-audit-assessment";
import { auditablePackages, dependencyChanges } from "./dependency-audit-scope";

const SCRIPTS_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");
const BASELINE_PATH = path.resolve(REPO_ROOT, BASELINE_PATHS.dependencyAudit);
const GATED_SEVERITIES = new Set(["high", "critical"]);

// Flags read by the workflow's remediation job.
const markOutput = (name: "advisory_failure" | "stale_acceptance"): void => {
  const output = process.env["GITHUB_OUTPUT"];
  if (output !== undefined && output !== "") {
    appendFileSync(output, `${name}=true\n`);
  }
};

export type Advisory = {
  id: string;
  severity: string;
  package: string;
  title: string;
  /** The advisory's semver range, e.g. "<=1.4.0"; "" when not reported. */
  vulnerableVersions: string;
};

export type BaselineEntry = Omit<Advisory, "vulnerableVersions"> & {
  owner: string;
  reason: string;
  expiresOn?: string;
  untilPatched?: unknown;
  affectedPaths?: string[];
};

export type Baseline = {
  note: string;
  auditLevel: string;
  accepted: BaselineEntry[];
};

export class BaselineError extends Error {
  override readonly name = "BaselineError";
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// `bun audit --json` and the baseline file are both untrusted shape-wise.
// Coerce only the primitives that have a meaningful string form so an
// object-valued field degrades to "" instead of stringifying as
// "[object Object]" and being compared or persisted as that literal.
const asText = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" ? String(value) : "";
};

const requireAcceptanceText = (
  id: string,
  field: "owner" | "reason",
  value: unknown,
): string => {
  const text = asText(value);
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.toUpperCase().startsWith("TODO")) {
    return panic(
      `Dependency audit baseline entry ${id} must have a non-placeholder ${field}`,
    );
  }
  return text;
};

// The baseline is a repo-committed file this script owns, but a hand-edit that
// breaks an entry must not silently accept the advisory it was meant to cover.
// An unreadable entry is dropped, so the matching advisory reads as new and the
// gate fails closed.
const toBaselineEntry = (value: unknown): BaselineEntry | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = asText(value["id"]);
  if (id === "") {
    return null;
  }
  const owner = requireAcceptanceText(id, "owner", value["owner"]);
  const reason = requireAcceptanceText(id, "reason", value["reason"]);
  const expiresOn = value["expiresOn"];
  const untilPatched = value["untilPatched"];
  return {
    id,
    owner,
    severity: asText(value["severity"]),
    package: asText(value["package"]),
    title: asText(value["title"]),
    reason,
    ...(Array.isArray(value["affectedPaths"])
      ? { affectedPaths: value["affectedPaths"].map(asText) }
      : {}),
    // Present but malformed terms are kept as read, so the entry lapses
    // instead of silently becoming permanent.
    ...(expiresOn === undefined ? {} : { expiresOn: asText(expiresOn) }),
    ...(untilPatched === undefined ? {} : { untilPatched }),
  };
};

export const readBaseline = async (
  baselinePath: string = BASELINE_PATH,
): Promise<Baseline> => {
  try {
    const file = Bun.file(baselinePath);
    if (!(await file.exists())) {
      return { note: "", auditLevel: "high", accepted: [] };
    }
    const parsed: unknown = await file.json();
    const accepted = isRecord(parsed) ? parsed["accepted"] : undefined;
    return {
      note: isRecord(parsed) ? asText(parsed["note"]) : "",
      auditLevel: isRecord(parsed) ? asText(parsed["auditLevel"]) : "high",
      accepted: Array.isArray(accepted)
        ? accepted
            .map(toBaselineEntry)
            .filter((entry): entry is BaselineEntry => entry !== null)
        : [],
    };
  } catch (error) {
    throw new BaselineError(errorMessage(error), { cause: error });
  }
};

const GHSA_ID = /GHSA-[a-z0-9-]+/iu;

const ghsaId = (advisory: Record<string, unknown>): string => {
  const url = asText(advisory["url"]);
  const fromUrl = GHSA_ID.exec(url)?.[0];
  if (fromUrl !== undefined) {
    return fromUrl;
  }
  const fromFields = asText(advisory["github_advisory_id"] ?? advisory["id"]);
  return fromFields === "" ? "unknown" : fromFields;
};

// Raised when `bun audit` itself fails (crash, network, unparseable output)
// rather than reporting a clean lockfile. The gate must fail closed on this:
// an external-tool failure must never be conflated with "no advisories".
export class AuditCommandError extends Error {
  override readonly name = "AuditCommandError";
}

type AuditProcessResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

// Returns the parsed payload as `unknown`; every downstream read narrows it.
// A syntactically invalid payload is caught here and returned as null, which
// the caller treats as a failed audit (fail-closed).
const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Interpret a raw `bun audit --json` result into gated advisories, or throw
// AuditCommandError when the audit did not actually run to completion. Pure and
// synchronous so the self-test can exercise the fail-closed contract directly.
//
// `bun audit` contract:
//   exit 0    + empty stdout  -> clean lockfile (no advisories)
//   exit 0/!0 + advisory JSON -> advisories found (nonzero when it finds any)
//   nonzero   + no/garbage out -> the audit tool failed; DO NOT treat as clean
const gatedAdvisoriesFromAuditResult = ({
  exitCode,
  stderr,
  stdout,
}: AuditProcessResult): Advisory[] => {
  const trimmed = stdout.trim();

  if (trimmed.length === 0) {
    if (exitCode === 0) {
      // Clean: `bun audit --json` prints nothing and exits 0.
      return [];
    }
    const detail = stderr.trim();
    throw new AuditCommandError(
      `bun audit exited ${exitCode} without producing audit JSON; the audit itself failed and cannot be treated as clean.${
        detail ? `\n${detail}` : ""
      }`,
    );
  }

  const parsed = safeJsonParse(trimmed);
  if (parsed === null) {
    throw new AuditCommandError(
      `bun audit (exit ${exitCode}) produced output that is not valid JSON; refusing to treat an unparseable audit as clean.`,
    );
  }

  // `bun audit` groups advisories by package under an `advisories` key (older
  // shape: at the top level). Either way this is untrusted shape, so a payload
  // that is not an object produces zero advisories rather than a throw.
  const container = isRecord(parsed) ? parsed : {};
  const grouped = isRecord(container["advisories"])
    ? container["advisories"]
    : container;

  const byAdvisory = new Map<string, Advisory>();
  for (const [pkg, value] of Object.entries(grouped)) {
    const list = Array.isArray(value) ? value : [value];
    for (const advisory of list) {
      // Each entry is untrusted: a missing or wrong-typed field degrades to an
      // empty/"unknown" value, and the severity gate skips anything that is not
      // exactly "high"/"critical".
      if (!isRecord(advisory)) {
        continue;
      }
      const severity = asText(advisory["severity"]);
      if (!GATED_SEVERITIES.has(severity)) {
        continue;
      }
      const id = ghsaId(advisory);
      const key = `${id}\0${pkg}`;
      if (!byAdvisory.has(key)) {
        byAdvisory.set(key, {
          id,
          severity,
          package: pkg,
          title: asText(advisory["title"]),
          vulnerableVersions: asText(advisory["vulnerable_versions"]),
        });
      }
    }
  }
  return [...byAdvisory.values()].toSorted(
    (a, b) =>
      compareCodeUnit(a.id, b.id) || compareCodeUnit(a.package, b.package),
  );
};

// Runs `bun audit --json` in the repo root and returns the distinct gated
// (high/critical) advisories. `bun audit` groups advisories by package name.
type AuditRunner = (cwd?: string) => Promise<AuditProcessResult>;

const runAudit: AuditRunner = async (cwd = REPO_ROOT) => {
  const proc = Bun.spawn(["bun", "audit", "--json"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stderr, stdout };
};

type CollectGatedAdvisoriesOptions = {
  delay?: (milliseconds: number) => Promise<void>;
  run?: AuditRunner;
};

const TRANSIENT_AUDIT_FAILURE =
  /(?:- 5\d\d\b|ECONNRESET|ETIMEDOUT|ConnectionRefused|fetch failed)/u;
const RETRY_DELAYS_MS = [10_000, 30_000] as const;

export const collectGatedAdvisories = async ({
  delay = async (milliseconds) => {
    await Bun.sleep(milliseconds);
  },
  run = runAudit,
}: CollectGatedAdvisoriesOptions = {}): Promise<Advisory[]> => {
  for (let attempt = 0; ; attempt += 1) {
    const result = await run();
    try {
      return gatedAdvisoriesFromAuditResult(result);
    } catch (error) {
      const retryDelay = RETRY_DELAYS_MS.at(attempt);
      const producedJson = safeJsonParse(result.stdout.trim()) !== null;
      if (
        !(error instanceof AuditCommandError) ||
        result.exitCode === 0 ||
        producedJson ||
        !TRANSIENT_AUDIT_FAILURE.test(result.stderr) ||
        retryDelay === undefined
      ) {
        throw error;
      }
      console.warn(
        `bun audit failed transiently; retrying in ${retryDelay / 1000}s (attempt ${attempt + 2} of ${RETRY_DELAYS_MS.length + 1}).`,
      );
      await delay(retryDelay);
    }
  }
};

const formatAdvisory = (advisory: Advisory): string =>
  `  ${advisory.severity.toUpperCase().padEnd(8)} ${advisory.id}  ${advisory.package} — ${advisory.title}`;

const formatAcceptanceTerm = (acceptance: BaselineEntry): string => {
  if (acceptance.expiresOn !== undefined) {
    return `accepted until ${acceptance.expiresOn}${acceptance.untilPatched === true ? " or until patched" : ""}`;
  }
  return acceptance.untilPatched === true ? "until patched" : "accepted";
};

const assessCurrent = async (advisories: Advisory[]): Promise<void> => {
  const [baseline, lockfile, manifest, policy] = await Promise.all([
    readBaseline(),
    Bun.file(path.resolve(REPO_ROOT, "bun.lock")).text(),
    Bun.file(path.resolve(REPO_ROOT, "package.json")).json(),
    readRootReleaseAgePolicy(),
  ]);
  const now = new Date();
  const versions = new Map(
    await Promise.all(
      [...new Set(advisories.map(({ package: name }) => name))].map(
        async (name) =>
          [name, await readInstallableVersions(name, policy, now)] as const,
      ),
    ),
  );
  printAssessments(
    assessAdvisories({
      advisories,
      accepted: baseline.accepted,
      lockfile,
      manifest,
      versions,
    }),
  );
};

const saveBaseline = async (
  baseline: Baseline,
  baselinePath: string = BASELINE_PATH,
): Promise<void> => {
  await Bun.write(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
};

// Drops only the acceptances whose advisory is no longer reported; it never
// adds an entry, so it cannot accept a new advisory.
export const pruneBaseline = async (
  advisories: Advisory[],
  baselinePath: string = BASELINE_PATH,
): Promise<void> => {
  const baseline = await readBaseline(baselinePath);
  const { resolved } = diffAgainstBaseline(advisories, baseline);
  if (resolved.length === 0) {
    console.info("No stale acceptances to remove.");
    return;
  }
  const resolvedIds = new Set(resolved.map(({ id }) => id));
  await saveBaseline(
    {
      ...baseline,
      accepted: baseline.accepted.filter(({ id }) => !resolvedIds.has(id)),
    },
    baselinePath,
  );
  console.info(
    `Removed ${resolved.length} stale acceptance(s): ${[...resolvedIds].join(", ")}.`,
  );
};

export const writeBaseline = async (
  advisories: Advisory[],
  baselinePath: string = BASELINE_PATH,
): Promise<void> => {
  const existing = await readBaseline(baselinePath);
  const existingById = new Map(
    existing.accepted.map((entry) => [advisoryKey(entry), entry]),
  );
  const baseline: Baseline = {
    note: existing.note,
    auditLevel: "high",
    accepted: advisories.map(({ id, severity, package: pkg, title }) => {
      const kept = existingById.get(advisoryKey({ id, package: pkg }));
      return {
        id,
        owner: kept?.owner ?? "TODO: owner",
        severity,
        package: pkg,
        title,
        reason: kept?.reason ?? "TODO: document why this is accepted.",
        ...(kept?.expiresOn === undefined ? {} : { expiresOn: kept.expiresOn }),
        ...(kept?.affectedPaths === undefined
          ? {}
          : { affectedPaths: kept.affectedPaths }),
        ...(kept?.untilPatched === undefined
          ? {}
          : { untilPatched: kept.untilPatched }),
      };
    }),
  };
  await saveBaseline(baseline, baselinePath);
  console.info(
    `Wrote ${advisories.length} advisory(ies) to ${repoRelativePath(REPO_ROOT, BASELINE_PATH)}. Replace all TODO placeholders before committing the baseline.`,
  );
};

// One advisory identity everywhere: the same GHSA can affect several
// packages, and an acceptance covers only the package it names.
const advisoryKey = ({
  id,
  package: pkg,
}: Pick<Advisory, "id" | "package">): string => `${id}\0${pkg}`;

// Diff current advisories against the baseline. `newlyIntroduced` fails the
// gate; `resolved` only warns (prompt to ratchet the baseline down).
export const diffAgainstBaseline = (
  advisories: Advisory[],
  baseline: Baseline,
): { newlyIntroduced: Advisory[]; resolved: BaselineEntry[] } => {
  const currentKeys = new Set(advisories.map(advisoryKey));
  const baselineKeys = new Set(baseline.accepted.map(advisoryKey));
  return {
    newlyIntroduced: advisories.filter(
      (a) => !baselineKeys.has(advisoryKey(a)),
    ),
    resolved: baseline.accepted.filter((a) => !currentKeys.has(advisoryKey(a))),
  };
};

const readRootReleaseAgePolicy = async () =>
  readReleaseAgePolicy(
    await Bun.file(path.resolve(REPO_ROOT, "bunfig.toml")).text(),
  );

// The newest stable release Bun would install now, or undefined when the
// lookup fails; an `untilPatched` acceptance then lapses (fail closed). A
// patch still in quarantine is not installable, so it lapses nothing yet.
const fetchLatestVersion = async (
  pkg: string,
  now: Date,
): Promise<LatestInstallableRelease | undefined> => {
  const installable = await Result.tryPromise(async () =>
    readInstallableReleases(pkg, await readRootReleaseAgePolicy(), now),
  );
  if (Result.isError(installable)) {
    return undefined;
  }
  return installable.value
    .filter(({ version }) => !version.includes("-"))
    .toSorted((left, right) => Bun.semver.order(left.version, right.version))
    .at(-1);
};

type CheckLapsedAcceptancesOptions = {
  advisories: Advisory[];
  baseline: Baseline;
  today: string;
  now: Date;
  enforceDateExpiry: boolean;
  latestVersion?:
    | ((
        pkg: string,
        now: Date,
      ) => Promise<LatestInstallableRelease | undefined>)
    | undefined;
};
const checkLapsedAcceptances = async ({
  advisories,
  baseline,
  today,
  now,
  enforceDateExpiry,
  latestVersion = fetchLatestVersion,
}: CheckLapsedAcceptancesOptions): Promise<LapsedAcceptance[]> => {
  const packages = new Set(
    baseline.accepted
      .filter(({ untilPatched }) => untilPatched === true)
      .map((entry) => entry.package),
  );
  const latest = new Map(
    await Promise.all(
      [...packages].map(
        async (pkg) => [pkg, await latestVersion(pkg, now)] as const,
      ),
    ),
  );
  const lapsed = lapsedAcceptances({
    accepted: baseline.accepted,
    current: advisories,
    today,
    enforceDateExpiry,
    latestVersion: (pkg) => latest.get(pkg),
    now,
  });
  const windows = patchedAcceptanceWindows({
    accepted: baseline.accepted,
    current: advisories,
    latestVersion: (pkg) => latest.get(pkg),
  });
  for (const window of windows) {
    console.info(
      `${window.id} for ${window.package}: patch installable since ${window.installableSince}, lapses at ${window.lapsesAt}`,
    );
  }
  if (lapsed.length === 0) {
    return [];
  }
  console.error(
    `${lapsed.length} temporary advisory acceptance(s) lapsed; bump the dependency or re-review the entry in scripts/dependency-audit-baseline.json:`,
  );
  for (const entry of lapsed) {
    console.error(`  ${entry.id}  ${entry.package}: ${entry.reason}`);
  }
  return lapsed;
};

const githubCommandValue = (value: string): string =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

type WarningFormat = "github" | "plain";

type WarnBeforeExpiryOptions = {
  advisories: Advisory[];
  baseline: Baseline;
  today: string;
  format: WarningFormat;
};

const warn = (format: WarningFormat, title: string, message: string): void => {
  switch (format) {
    case "github":
      console.warn(`::warning title=${title}::${githubCommandValue(message)}`);
      break;
    case "plain":
      console.warn(`WARNING: ${message}`);
      break;
    default:
      format satisfies never;
      panic("unhandled warning format");
  }
};

const warnBeforeExpiry = ({
  advisories,
  baseline,
  today,
  format,
}: WarnBeforeExpiryOptions): void => {
  for (const entry of expiringAcceptances({
    accepted: baseline.accepted,
    current: advisories,
    today,
  })) {
    warn(
      format,
      "Dependency audit acceptance expiring",
      `${entry.id} for ${entry.package} is accepted until ${entry.expiresOn}; review or remediate it before expiry.`,
    );
  }
};

type CheckOptions = {
  baseline?: Baseline;
  /** Defaults to true for API callers; scheduled CLI audits opt out. */
  enforceDateExpiry?: boolean;
  latestVersion?: (
    pkg: string,
    now: Date,
  ) => Promise<LatestInstallableRelease | undefined>;
  now?: () => Date;
  packages?: ReadonlySet<string>;
  /** Defaults to GitHub annotations inside GitHub Actions. */
  warningFormat?: WarningFormat;
};

type CheckResult = {
  lapsed: LapsedAcceptance[];
  newlyIntroduced: Advisory[];
  status: number;
};

const checkResult = async (
  advisories: Advisory[],
  options: CheckOptions = {},
): Promise<CheckResult> => {
  const completeBaseline = options.baseline ?? (await readBaseline());
  const baseline =
    options.packages === undefined
      ? completeBaseline
      : {
          note: completeBaseline.note,
          auditLevel: completeBaseline.auditLevel,
          accepted: completeBaseline.accepted.filter(({ package: pkg }) =>
            options.packages?.has(pkg),
          ),
        };
  const { newlyIntroduced, resolved } = diffAgainstBaseline(
    advisories,
    baseline,
  );
  // UTC calendar date; an acceptance holds through its expiresOn day.
  const now = options.now?.() ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const warningFormat =
    options.warningFormat ??
    (process.env["GITHUB_ACTIONS"] === "true" ? "github" : "plain");
  warnBeforeExpiry({ advisories, baseline, today, format: warningFormat });
  const lapsed = await checkLapsedAcceptances({
    advisories,
    baseline,
    today,
    now,
    enforceDateExpiry: options.enforceDateExpiry ?? true,
    latestVersion: options.latestVersion,
  });
  const lapsedKeys = new Set(lapsed.map(advisoryKey));

  for (const advisory of advisories) {
    const acceptance = baseline.accepted.find(
      (entry) => advisoryKey(entry) === advisoryKey(advisory),
    );
    if (acceptance === undefined) {
      console.info(`${formatAdvisory(advisory)}  NEW`);
      continue;
    }
    if (lapsedKeys.has(advisoryKey(advisory))) {
      console.info(`${formatAdvisory(advisory)}  LAPSED`);
      continue;
    }
    console.info(
      `${formatAdvisory(advisory)}  ${formatAcceptanceTerm(acceptance)} (owner: ${acceptance.owner})`,
    );
  }

  if (resolved.length > 0) {
    warn(
      warningFormat,
      "Dependency audit acceptance stale",
      `${resolved.map(({ id, package: pkg }) => `${id} for ${pkg}`).join(", ")} is accepted but no longer reported; the scheduled remediation removes the acceptance (bun scripts/dependency-audit.ts --prune-baseline).`,
    );
    markOutput("stale_acceptance");
  }

  if (newlyIntroduced.length === 0) {
    console.info(
      `No new high/critical advisories (${baseline.accepted.length} known and accepted).`,
    );
    if (lapsed.length > 0) {
      markOutput("advisory_failure");
    }
    return {
      lapsed,
      newlyIntroduced,
      status: lapsed.length > 0 ? 2 : 0,
    };
  }

  console.error(
    `${newlyIntroduced.length} NEW high/critical advisory(ies) not in the baseline:`,
  );
  for (const advisory of newlyIntroduced) {
    console.error(formatAdvisory(advisory));
  }
  console.error(
    "\nFix the dependency (bun update / override), or, if it is genuinely not reachable, add it to scripts/dependency-audit-baseline.json with a reason.",
  );
  markOutput("advisory_failure");
  return {
    lapsed,
    newlyIntroduced,
    status: lapsed.length > 0 ? 2 : 1,
  };
};

export const check = async (
  advisories: Advisory[],
  options: CheckOptions = {},
): Promise<number> => (await checkResult(advisories, options)).status;

// Prove the gate fires without waiting for a real new advisory: inject a
// synthetic advisory that is absent from the baseline and assert it is caught,
// and prove a failed audit command fails closed rather than reading as clean.
const selfTest = async (): Promise<number> => {
  const baseline = await readBaseline();
  const synthetic: Advisory = {
    id: "GHSA-0000-0000-0000",
    severity: "critical",
    package: "self-test-package",
    title: "synthetic advisory",
    vulnerableVersions: "<=1.0.0",
  };
  const { newlyIntroduced } = diffAgainstBaseline([synthetic], baseline);
  if (!newlyIntroduced.some((a) => a.id === synthetic.id)) {
    panic("Self-test FAILED: synthetic advisory was not detected.");
  }

  // A failing `bun audit` (nonzero exit, no parseable JSON) must be surfaced as
  // an error, not silently accepted as a clean lockfile.
  let auditFailureFailedClosed = false;
  try {
    gatedAdvisoriesFromAuditResult({
      exitCode: 1,
      stderr: "error: failed to reach the advisory database",
      stdout: "",
    });
  } catch (error) {
    auditFailureFailedClosed = error instanceof AuditCommandError;
  }
  if (!auditFailureFailedClosed) {
    panic("Self-test FAILED: a failing audit command was treated as clean.");
  }

  console.info(
    "Self-test passed: a new advisory is detected by --check and a failed audit fails closed.",
  );
  return 0;
};

const gitFile = async (revision: string, file: string): Promise<string> => {
  const proc = Bun.spawn(["git", "show", `${revision}:${file}`], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new AuditCommandError(
      `Unable to read ${file} at ${revision}: ${stderr.trim()}`,
    );
  }
  return stdout;
};

const checkDiff = async (baseRevision: string): Promise<number> => {
  const [baseLockfile, headLockfile, baseBaseline, headBaseline] =
    await Promise.all([
      gitFile(baseRevision, "bun.lock"),
      Bun.file(path.resolve(REPO_ROOT, "bun.lock")).text(),
      gitFile(baseRevision, BASELINE_PATHS.dependencyAudit),
      Bun.file(BASELINE_PATH).text(),
    ]);
  const baselineChanged = baseBaseline !== headBaseline;
  const changes = dependencyChanges(baseLockfile, headLockfile);
  const packages = auditablePackages(changes);
  console.info(
    `Lockfile diff: ${changes.added.length} added, ${changes.changed.length} changed, ${changes.removed.length} removed dependency package(s); ${packages.size} added or changed name(s) are registry-resolved.`,
  );
  if (packages.size === 0 && !baselineChanged) {
    console.info("No added or changed registry resolutions to audit.");
    return 0;
  }
  const currentAdvisories = await collectGatedAdvisories();
  const advisories = baselineChanged
    ? currentAdvisories
    : currentAdvisories.filter(({ package: pkg }) => packages.has(pkg));
  await assessCurrent(advisories);
  return check(advisories, {
    ...(baselineChanged ? {} : { packages }),
    enforceDateExpiry: baselineChanged,
  });
};

export const checkRelease = async (
  advisories: Advisory[],
  previousAdvisories: Advisory[] = [],
  options: CheckOptions = {},
): Promise<number> => {
  const baseline = options.baseline ?? (await readBaseline());
  const { added, carried, fixed } = classifyAuditDelta(
    advisories,
    previousAdvisories,
    advisoryKey,
  );
  const addedKeys = new Set(added.map(advisoryKey));
  const addedBaseline = {
    ...baseline,
    accepted: baseline.accepted.filter((entry) =>
      addedKeys.has(advisoryKey(entry)),
    ),
  };
  const result = await checkResult(added, {
    ...options,
    baseline: addedBaseline,
  });
  const invalidAcceptanceIds = new Set<string>();

  for (const acceptance of baseline.accepted) {
    if (!addedKeys.has(advisoryKey(acceptance))) {
      continue;
    }
    console.warn(
      `::warning title=Release dependency audit accepted advisory::${githubCommandValue(`${acceptance.id} for ${acceptance.package} is accepted by ${acceptance.owner} until ${acceptance.expiresOn ?? "missing"}.`)}`,
    );
    if (acceptance.expiresOn === undefined) {
      invalidAcceptanceIds.add(acceptance.id);
      console.error(
        `Release dependency audit acceptance ${acceptance.id} must have expiresOn; untilPatched alone is not sufficient.`,
      );
    }
    const owner = acceptance.owner.trim();
    if (owner === "" || owner.toUpperCase().startsWith("TODO")) {
      invalidAcceptanceIds.add(acceptance.id);
      console.error(
        `Release dependency audit acceptance ${acceptance.id} must have a non-placeholder owner.`,
      );
    }
  }

  for (const advisory of carried) {
    const acceptance = baseline.accepted.find(
      (entry) => advisoryKey(entry) === advisoryKey(advisory),
    );
    const detail =
      acceptance === undefined
        ? "Add a baseline entry with an owner and an expiry."
        : `Baseline owner: ${acceptance.owner}; expiry: ${acceptance.expiresOn ?? "missing"}.`;
    warn(
      options.warningFormat ?? "github",
      "Release dependency advisory already in production",
      `${advisory.id} for ${advisory.package}: production already carries this advisory. ${detail}`,
    );
  }

  for (const advisory of fixed) {
    console.info(
      `Release dependency audit fixed ${advisory.id} for ${advisory.package}.`,
    );
  }

  if (invalidAcceptanceIds.size > 0 || result.lapsed.length > 0) {
    return 2;
  }
  return result.status;
};

export const classifyAuditDelta = <T>(
  current: T[],
  previous: T[],
  key: (finding: T) => string,
): { added: T[]; carried: T[]; fixed: T[] } => {
  const previousKeys = new Set(previous.map(key));
  const currentKeys = new Set(current.map(key));
  return {
    added: current.filter((finding) => !previousKeys.has(key(finding))),
    carried: current.filter((finding) => previousKeys.has(key(finding))),
    fixed: previous.filter((finding) => !currentKeys.has(key(finding))),
  };
};

type ReleaseAuditDependencies = {
  audit?: (cwd?: string) => Promise<Advisory[]>;
  gitFile?: (revision: string, file: string) => Promise<string>;
  previousReleaseTag?: () => Promise<string | undefined>;
};

const previousReleaseTag = async (): Promise<string | undefined> => {
  const merged = await gitTagList([
    "--merged",
    "HEAD",
    "--sort=-version:refname",
  ]);
  const current = new Set(await gitTagList(["--points-at", "HEAD"]));
  for (const tag of merged) {
    if (/^v\d+\.\d+\.\d+$/u.test(tag) && !current.has(tag)) {
      return tag;
    }
  }
  return undefined;
};

const gitTagList = async (args: string[]): Promise<string[]> => {
  const proc = Bun.spawn(["git", "tag", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new AuditCommandError(
      `Unable to list previous release tags: ${stderr.trim()}`,
    );
  }
  return stdout.split("\n").filter((tag) => tag !== "");
};

const auditPreviousRelease = async (
  tag: string,
  audit: (cwd?: string) => Promise<Advisory[]>,
  readGitFile: (revision: string, file: string) => Promise<string>,
): Promise<Advisory[]> => {
  const directory = mkdtempSync(path.join(tmpdir(), "stella-release-audit-"));
  try {
    await Bun.write(
      path.join(directory, "bun.lock"),
      await readGitFile(tag, "bun.lock"),
    );
    await Bun.write(
      path.join(directory, "package.json"),
      await readGitFile(tag, "package.json"),
    );
    return await audit(directory);
  } catch (error) {
    throw new AuditCommandError(
      `Unable to audit previous release ${tag}: ${errorMessage(error)}. Verify that the tag contains an auditable bun.lock and package.json, then retry.`,
      { cause: error },
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

export const runReleaseCheck = async ({
  audit = async (cwd) =>
    collectGatedAdvisories({ run: async () => runAudit(cwd) }),
  gitFile: readGitFile = gitFile,
  previousReleaseTag: findPreviousReleaseTag = previousReleaseTag,
}: ReleaseAuditDependencies = {}): Promise<number> => {
  const current = await audit();
  const tag = await findPreviousReleaseTag();
  const previous =
    tag === undefined
      ? []
      : await auditPreviousRelease(tag, audit, readGitFile);
  return checkRelease(current, previous);
};

const main = async (): Promise<number> => {
  const arg = process.argv[2];

  if (arg === "--check-diff") {
    const baseRevision = process.argv[3];
    if (baseRevision === undefined || baseRevision === "") {
      throw new AuditCommandError(
        "--check-diff requires a merge-base revision",
      );
    }
    return checkDiff(baseRevision);
  }

  if (arg === "--release") {
    return runReleaseCheck();
  }

  if (arg === "--self-test") {
    return selfTest();
  }

  if (arg === "--write-baseline") {
    await writeBaseline(await collectGatedAdvisories());
    return 0;
  }

  if (arg === "--prune-baseline") {
    await pruneBaseline(await collectGatedAdvisories());
    return 0;
  }

  const advisories = await collectGatedAdvisories();

  await assessCurrent(advisories);
  if (arg === "--check" || arg === "--assess") {
    return check(advisories, { enforceDateExpiry: false });
  }
  return 0;
};

export const runDependencyAuditCli = async (
  run: () => Promise<number> = main,
): Promise<number> => {
  try {
    return await run();
  } catch (error) {
    console.error(errorMessage(error));
    // 2 means lapsed acceptances, which remediation may still fix; an
    // unreadable baseline is a command failure that must stop it.
    if (
      error instanceof BaselineError ||
      error instanceof AuditCommandError ||
      error instanceof AuditAssessmentError
    ) {
      return 3;
    }
    return 4;
  }
};

if (import.meta.main) {
  process.exit(await runDependencyAuditCli());
}
