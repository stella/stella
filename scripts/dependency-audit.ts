// Dependency vulnerability guard.
//
// `bun audit` checks the lockfile against the npm advisory database, but it
// exits 0 even when advisories exist, so on its own it cannot gate CI. This
// wraps it into a ratchet, mirroring scripts/bundle-baseline.ts: every current
// high/critical advisory is recorded in scripts/dependency-audit-baseline.json
// with a reason, and the --check mode fails only when a NEW high/critical
// advisory appears that is not in the baseline. Known-and-accepted advisories
// (transitive, non-reachable) are tracked, not silently ignored, and the guard
// warns when a baselined advisory has been resolved so the baseline can be
// ratcheted down.
//
// This is a supply-chain complement to the 5-day `minimumReleaseAge` quarantine
// in bunfig.toml (which blocks freshly published — potentially malicious —
// versions at install time); this guard catches KNOWN vulnerabilities in the
// versions already resolved.
//
// Modes:
//   bun scripts/dependency-audit.ts                 report current high/critical advisories
//   bun scripts/dependency-audit.ts --check         full-tree gate: exit 1 on a new high/critical advisory
//   bun scripts/dependency-audit.ts --check-diff REF PR gate: audit only resolutions changed since REF
//   bun scripts/dependency-audit.ts --release       release gate: exit 1 on any high/critical advisory
//   bun scripts/dependency-audit.ts --write-baseline regenerate the baseline from the current audit
//   bun scripts/dependency-audit.ts --self-test     prove the comparison logic fires
//
// A baseline entry may be temporary: `expiresOn` and `untilPatched` make the
// acceptance lapse (and --check fail) after a date or once a patched release
// is published; see scripts/dependency-audit-acceptance.ts.

import { Result } from "better-result";
import { appendFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import { BASELINE_PATHS } from "./baseline-paths";
import { lapsedAcceptances } from "./dependency-audit-acceptance";
import { auditablePackages, dependencyChanges } from "./dependency-audit-scope";

const SCRIPTS_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");
const BASELINE_PATH = path.resolve(REPO_ROOT, BASELINE_PATHS.dependencyAudit);
const GATED_SEVERITIES = new Set(["high", "critical"]);

const markAdvisoryFailure = (): void => {
  const output = process.env["GITHUB_OUTPUT"];
  if (output !== undefined && output !== "") {
    appendFileSync(output, "advisory_failure=true\n");
  }
};

type Advisory = {
  id: string;
  severity: string;
  package: string;
  title: string;
  /** The advisory's semver range, e.g. "<=1.4.0"; "" when not reported. */
  vulnerableVersions: string;
};

type BaselineEntry = Omit<Advisory, "vulnerableVersions"> & {
  reason: string;
  expiresOn?: string;
  untilPatched?: unknown;
};

type Baseline = {
  note: string;
  auditLevel: string;
  accepted: BaselineEntry[];
};

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
  const expiresOn = value["expiresOn"];
  const untilPatched = value["untilPatched"];
  return {
    id,
    severity: asText(value["severity"]),
    package: asText(value["package"]),
    title: asText(value["title"]),
    reason: asText(value["reason"]),
    // Present but malformed terms are kept as read, so the entry lapses
    // instead of silently becoming permanent.
    ...(expiresOn === undefined ? {} : { expiresOn: asText(expiresOn) }),
    ...(untilPatched === undefined ? {} : { untilPatched }),
  };
};

const readBaseline = async (): Promise<Baseline> => {
  const file = Bun.file(BASELINE_PATH);
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
class AuditCommandError extends Error {
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

  const byId = new Map<string, Advisory>();
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
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          severity,
          package: pkg,
          title: asText(advisory["title"]),
          vulnerableVersions: asText(advisory["vulnerable_versions"]),
        });
      }
    }
  }
  return [...byId.values()].toSorted((a, b) => compareCodeUnit(a.id, b.id));
};

// Runs `bun audit --json` in the repo root and returns the distinct gated
// (high/critical) advisories. `bun audit` groups advisories by package name.
const collectGatedAdvisories = async (): Promise<Advisory[]> => {
  const proc = Bun.spawn(["bun", "audit", "--json"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return gatedAdvisoriesFromAuditResult({ exitCode, stderr, stdout });
};

const formatAdvisory = (advisory: Advisory): string =>
  `  ${advisory.severity.toUpperCase().padEnd(8)} ${advisory.id}  ${advisory.package} — ${advisory.title}`;

const report = (advisories: Advisory[]): void => {
  if (advisories.length === 0) {
    console.info("No high/critical advisories.");
    return;
  }
  console.info(`${advisories.length} high/critical advisory(ies):`);
  for (const advisory of advisories) {
    console.info(formatAdvisory(advisory));
  }
};

const writeBaseline = async (advisories: Advisory[]): Promise<void> => {
  const existing = await readBaseline();
  const existingById = new Map(existing.accepted.map((e) => [e.id, e]));
  const baseline: Baseline = {
    note: existing.note,
    auditLevel: "high",
    accepted: advisories.map(({ id, severity, package: pkg, title }) => {
      const kept = existingById.get(id);
      return {
        id,
        severity,
        package: pkg,
        title,
        reason: kept?.reason ?? "TODO: document why this is accepted.",
        ...(kept?.expiresOn === undefined ? {} : { expiresOn: kept.expiresOn }),
        ...(kept?.untilPatched === undefined
          ? {}
          : { untilPatched: kept.untilPatched }),
      };
    }),
  };
  await Bun.write(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.info(
    `Wrote ${advisories.length} advisory(ies) to ${path.relative(REPO_ROOT, BASELINE_PATH)}.`,
  );
};

// Diff current advisories against the baseline. `newlyIntroduced` fails the
// gate; `resolved` only warns (prompt to ratchet the baseline down).
const diffAgainstBaseline = (
  advisories: Advisory[],
  baseline: Baseline,
): { newlyIntroduced: Advisory[]; resolved: BaselineEntry[] } => {
  const currentIds = new Set(advisories.map((a) => a.id));
  const baselineIds = new Set(baseline.accepted.map((a) => a.id));
  return {
    newlyIntroduced: advisories.filter((a) => !baselineIds.has(a.id)),
    resolved: baseline.accepted.filter((a) => !currentIds.has(a.id)),
  };
};

// The npm registry's `latest` dist-tag for a package, or undefined when the
// lookup fails; an `untilPatched` acceptance then lapses (fail closed).
const fetchLatestVersion = async (pkg: string): Promise<string | undefined> => {
  const response = await Result.tryPromise(async () =>
    fetch(`https://registry.npmjs.org/${pkg.replaceAll("/", "%2f")}/latest`, {
      signal: AbortSignal.timeout(15_000),
    }),
  );
  if (Result.isError(response) || !response.value.ok) {
    return undefined;
  }
  const body = await Result.tryPromise(async (): Promise<unknown> =>
    response.value.json(),
  );
  if (Result.isError(body) || !isRecord(body.value)) {
    return undefined;
  }
  const version = asText(body.value["version"]);
  return version === "" ? undefined : version;
};

const checkLapsedAcceptances = async (
  advisories: Advisory[],
  baseline: Baseline,
): Promise<number> => {
  const packages = new Set(
    baseline.accepted
      .filter(({ untilPatched }) => untilPatched === true)
      .map((entry) => entry.package),
  );
  const latest = new Map(
    await Promise.all(
      [...packages].map(
        async (pkg) => [pkg, await fetchLatestVersion(pkg)] as const,
      ),
    ),
  );
  const lapsed = lapsedAcceptances({
    accepted: baseline.accepted,
    current: advisories,
    // UTC calendar date; an acceptance holds through its expiresOn day.
    today: new Date().toISOString().slice(0, 10),
    latestVersion: (pkg) => latest.get(pkg),
  });
  if (lapsed.length === 0) {
    return 0;
  }
  console.error(
    `${lapsed.length} temporary advisory acceptance(s) lapsed; bump the dependency or re-review the entry in scripts/dependency-audit-baseline.json:`,
  );
  for (const entry of lapsed) {
    console.error(`  ${entry.id}  ${entry.package}: ${entry.reason}`);
  }
  return 1;
};

const check = async (
  advisories: Advisory[],
  packages?: ReadonlySet<string>,
): Promise<number> => {
  const completeBaseline = await readBaseline();
  const baseline =
    packages === undefined
      ? completeBaseline
      : {
          note: completeBaseline.note,
          auditLevel: completeBaseline.auditLevel,
          accepted: completeBaseline.accepted.filter(({ package: pkg }) =>
            packages.has(pkg),
          ),
        };
  const { newlyIntroduced, resolved } = diffAgainstBaseline(
    advisories,
    baseline,
  );
  const lapsedStatus = await checkLapsedAcceptances(advisories, baseline);

  if (resolved.length > 0) {
    console.warn(
      `${resolved.length} baselined advisory(ies) are no longer present — ratchet the baseline down (bun scripts/dependency-audit.ts --write-baseline):`,
    );
    for (const advisory of resolved) {
      console.warn(`  ${advisory.id}  ${advisory.package}`);
    }
  }

  if (newlyIntroduced.length === 0) {
    console.info(
      `No new high/critical advisories (${baseline.accepted.length} known and accepted).`,
    );
    if (lapsedStatus !== 0) {
      markAdvisoryFailure();
    }
    return lapsedStatus;
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
  markAdvisoryFailure();
  return 1;
};

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
    console.error("Self-test FAILED: synthetic advisory was not detected.");
    return 1;
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
    console.error(
      "Self-test FAILED: a failing audit command was treated as clean.",
    );
    return 1;
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
  const [baseLockfile, headLockfile] = await Promise.all([
    gitFile(baseRevision, "bun.lock"),
    Bun.file(path.resolve(REPO_ROOT, "bun.lock")).text(),
  ]);
  const changes = dependencyChanges(baseLockfile, headLockfile);
  const packages = auditablePackages(changes);
  console.info(
    `Lockfile diff: ${changes.added.length} added, ${changes.changed.length} changed, ${changes.removed.length} removed dependency package(s).`,
  );
  if (packages.size === 0) {
    console.info("No added or changed dependency resolutions to audit.");
    return 0;
  }
  const advisories = (await collectGatedAdvisories()).filter(
    ({ package: pkg }) => packages.has(pkg),
  );
  return check(advisories, packages);
};

const checkRelease = async (): Promise<number> => {
  const advisories = await collectGatedAdvisories();
  if (advisories.length === 0) {
    console.info("Release dependency audit found no high/critical advisories.");
    return 0;
  }
  console.error("Release dependency audit found high/critical advisories:");
  for (const advisory of advisories) {
    console.error(formatAdvisory(advisory));
  }
  return 1;
};

const main = async (): Promise<void> => {
  const arg = process.argv[2];

  if (arg === "--check-diff") {
    const baseRevision = process.argv[3];
    if (baseRevision === undefined || baseRevision === "") {
      throw new AuditCommandError(
        "--check-diff requires a merge-base revision",
      );
    }
    process.exit(await checkDiff(baseRevision));
  }

  if (arg === "--release") {
    process.exit(await checkRelease());
  }

  if (arg === "--self-test") {
    process.exit(await selfTest());
  }

  if (arg === "--write-baseline") {
    await writeBaseline(await collectGatedAdvisories());
    return;
  }

  const advisories = await collectGatedAdvisories();

  if (arg === "--check") {
    process.exit(await check(advisories));
  }

  report(advisories);
};

try {
  await main();
} catch (error) {
  if (error instanceof AuditCommandError) {
    // Fail closed: the audit tool itself failed, so we cannot assert the
    // lockfile is clean. Surface the reason and exit nonzero to block the gate.
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
