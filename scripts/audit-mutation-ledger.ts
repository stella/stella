#!/usr/bin/env bun
// Generate the require-audit-on-mutation ledger for MCP and library code.
//
//   bun scripts/audit-mutation-ledger.ts --write   lower rows to the current
//                                                  counts; refuses growth
//   bun scripts/audit-mutation-ledger.ts --seed    record every current owner
//                                                  (introducing the scope only)
//
// The census runs the real rule in `census` mode, so the generator and the
// lint gate group writes by the same owner key.

import { panic } from "better-result";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AUDIT_MUTATION_LEDGER_REL,
  type AuditMutationLedgerRow,
  parseAuditMutationLedger,
} from "./audit-mutation-ledger-scope.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const RULE = "require-audit-on-mutation";
const CENSUS_DIRECTORIES = ["apps/api/src/mcp", "apps/api/src/lib"] as const;
const OWNER_MESSAGE = /^(?<owner>\S+) holds (?<count>\d+) unaudited/u;

/**
 * Why a baselined owner writes without an audit row, by where it lives. The
 * first matching pattern wins; the last row is the triage default.
 */
const REASONS: readonly (readonly [RegExp, string])[] = [
  [
    /\/(?:scheduler|scouts|signals)\//u,
    "Scheduled system job bookkeeping with no member actor; audit when the job changes member-visible state.",
  ],
  [
    /(?:queue|run-log|flow-executor|extraction-runs|work-obligation)/u,
    "Background work state transition; the request that started the work records the audit event.",
  ],
  [
    /deletion|offboarding|retention/u,
    "Deletion or retention pipeline step; the deletion request and its effect store own the audit trail.",
  ],
  [
    /\/(?:legal-search|case-law|infosoud|lists)\/|corpus/u,
    "Shared public corpus or index maintenance with no tenant actor.",
  ],
  [
    /\/search\//u,
    "Search projection derived from a write that is audited at its source.",
  ],
  [
    /auth|otp|session|link-grant|mcp-upstream/u,
    "Authentication or credential bookkeeping; the auth lifecycle owns its own security events.",
  ],
  [
    /\/usage\/|usage-|hosted-usage|counter/u,
    "Usage metering or counter row that is itself the accounting record.",
  ],
  [
    /entity-versions|\/files\/|folio-collab/u,
    "Document storage step called by an audited operation; confirm the caller records the event.",
  ],
  [
    /./u,
    "Write outside handlers that predates the audit scope; triage whether it needs its own audit event.",
  ],
];

const reasonFor = (file: string): string =>
  REASONS.find(([pattern]) => pattern.test(file))?.[1] ??
  panic(`no reason pattern matches ${file}`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Current unaudited writes per `<file>::<owner>`. */
const census = (): Map<string, number> => {
  const directory = mkdtempSync(path.join(tmpdir(), "audit-mutation-ledger-"));
  try {
    const configPath = path.join(directory, "census.json");
    const reportPath = path.join(directory, "report.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [path.join(REPO_ROOT, ".oxlint-plugins", `${RULE}.ts`)],
        rules: { [`${RULE}/${RULE}`]: ["error", { census: true }] },
      }),
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--bun",
        "oxlint",
        "-c",
        configPath,
        "-f",
        "json",
        ...CENSUS_DIRECTORIES,
      ],
      // The report runs to megabytes; a file avoids a truncated pipe.
      { cwd: REPO_ROOT, stderr: "pipe", stdout: Bun.file(reportPath) },
    );
    const stdout = readFileSync(reportPath, "utf-8");
    const report: unknown = stdout.trimStart().startsWith("{")
      ? JSON.parse(stdout)
      : panic(`oxlint census failed:\n${stdout}\n${result.stderr.toString()}`);
    const diagnostics =
      isRecord(report) && Array.isArray(report["diagnostics"])
        ? report["diagnostics"]
        : panic(
            `oxlint census produced no report: ${result.stderr.toString()}`,
          );
    const counts = new Map<string, number>();
    for (const diagnostic of diagnostics) {
      if (
        !isRecord(diagnostic) ||
        typeof diagnostic["code"] !== "string" ||
        !diagnostic["code"].startsWith(RULE) ||
        typeof diagnostic["filename"] !== "string" ||
        typeof diagnostic["message"] !== "string"
      ) {
        continue;
      }
      const file = path
        .relative(REPO_ROOT, path.resolve(REPO_ROOT, diagnostic["filename"]))
        .replaceAll("\\", "/");
      if (file.endsWith(".test.ts")) {
        continue;
      }
      const owner =
        OWNER_MESSAGE.exec(diagnostic["message"])?.groups?.["owner"] ??
        panic(`unexpected census message: ${diagnostic["message"]}`);
      const id = `${file}::${owner}`;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

const readLedger = (): AuditMutationLedgerRow[] => {
  const ledgerPath = path.join(REPO_ROOT, AUDIT_MUTATION_LEDGER_REL);
  if (!existsSync(ledgerPath)) {
    return [];
  }
  return parseAuditMutationLedger(
    JSON.parse(readFileSync(ledgerPath, "utf-8")),
    AUDIT_MUTATION_LEDGER_REL,
  );
};

/**
 * The next ledger: current counts, existing reasons kept. Without `seed`, an
 * owner the ledger does not hold, or holds at a lower count, is refused.
 */
export const nextAuditMutationLedger = ({
  current,
  previous,
  seed,
}: {
  current: ReadonlyMap<string, number>;
  previous: readonly AuditMutationLedgerRow[];
  seed: boolean;
}): { rows: AuditMutationLedgerRow[]; refused: string[] } => {
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const rows: AuditMutationLedgerRow[] = [];
  const refused: string[] = [];
  for (const [id, writes] of current) {
    const known = previousById.get(id);
    if (!seed && (known === undefined || writes > known.writes)) {
      refused.push(`${id}: ${known?.writes ?? 0} -> ${writes}`);
      continue;
    }
    const file = id.slice(0, id.indexOf("::"));
    rows.push({ id, writes, reason: known?.reason ?? reasonFor(file) });
  }
  return {
    rows: rows.toSorted((left, right) => left.id.localeCompare(right.id)),
    refused,
  };
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const seed = args.includes("--seed");
  if (!seed && !args.includes("--write")) {
    console.error("usage: audit-mutation-ledger.ts --write | --seed");
    process.exit(2);
  }
  const { rows, refused } = nextAuditMutationLedger({
    current: census(),
    previous: readLedger(),
    seed,
  });
  if (refused.length > 0) {
    console.error(
      "These owners gained unaudited writes. Add an audit emission (or a " +
        "reasoned `// audit: skip`) instead of growing the ledger:",
    );
    for (const line of refused) {
      console.error(`  ${line}`);
    }
    process.exit(1);
  }
  writeFileSync(
    path.join(REPO_ROOT, AUDIT_MUTATION_LEDGER_REL),
    `${JSON.stringify(rows, null, 2)}\n`,
  );
  const writes = rows.reduce((sum, row) => sum + row.writes, 0);
  console.log(
    `${AUDIT_MUTATION_LEDGER_REL}: ${rows.length} owners, ${writes} writes`,
  );
}
