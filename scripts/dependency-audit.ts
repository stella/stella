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
//   bun scripts/dependency-audit.ts --check         CI gate: exit 1 on a new high/critical advisory
//   bun scripts/dependency-audit.ts --write-baseline regenerate the baseline from the current audit
//   bun scripts/dependency-audit.ts --self-test     prove the comparison logic fires

import path from "node:path";

const SCRIPTS_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");
const BASELINE_PATH = path.resolve(
  SCRIPTS_DIR,
  "dependency-audit-baseline.json",
);
const GATED_SEVERITIES = new Set(["high", "critical"]);

type Advisory = {
  id: string;
  severity: string;
  package: string;
  title: string;
};

type BaselineEntry = Advisory & { reason: string };

type Baseline = {
  note: string;
  auditLevel: string;
  accepted: BaselineEntry[];
};

const readBaseline = async (): Promise<Baseline> => {
  const file = Bun.file(BASELINE_PATH);
  if (!(await file.exists())) {
    return { note: "", auditLevel: "high", accepted: [] };
  }
  return (await file.json()) as Baseline;
};

const ghsaId = (advisory: Record<string, unknown>): string => {
  const url = typeof advisory["url"] === "string" ? advisory["url"] : "";
  const fromUrl = url.match(/GHSA-[a-z0-9-]+/iu)?.[0];
  return (
    fromUrl ??
    String(advisory["github_advisory_id"] ?? advisory["id"] ?? "unknown")
  );
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

const safeJsonParse = (text: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(text) as Record<string, unknown>;
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

  const advisories = (parsed["advisories"] ?? parsed) as Record<
    string,
    unknown
  >;

  const byId = new Map<string, Advisory>();
  for (const [pkg, value] of Object.entries(advisories)) {
    const list = Array.isArray(value) ? value : [value];
    for (const raw of list) {
      const advisory = raw as Record<string, unknown>;
      const severity = String(advisory["severity"] ?? "");
      if (!GATED_SEVERITIES.has(severity)) {
        continue;
      }
      const id = ghsaId(advisory);
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          severity,
          package: pkg,
          title: String(advisory["title"] ?? ""),
        });
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
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
  const reasonById = new Map(existing.accepted.map((e) => [e.id, e.reason]));
  const baseline: Baseline = {
    note: existing.note,
    auditLevel: "high",
    accepted: advisories.map((a) => ({
      ...a,
      reason: reasonById.get(a.id) ?? "TODO: document why this is accepted.",
    })),
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

const check = async (advisories: Advisory[]): Promise<number> => {
  const baseline = await readBaseline();
  const { newlyIntroduced, resolved } = diffAgainstBaseline(
    advisories,
    baseline,
  );

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
    return 0;
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

const main = async (): Promise<void> => {
  const arg = process.argv[2];

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
