// Add each new dated exception at its owner, then register its adapter here.
// The census covers policy/config expiry keys; prose-only review promises need
// an explicit adapter (see docs/maintenance/dated-waivers.md).
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { compareCodeUnit } from "@stll/collation";

import {
  DOC_SOURCE_EXCLUSIONS,
  type NoLlmsTxtExclusion,
} from "../.claude/mcp/doc-sources";
import {
  readReleaseAgeExceptions,
  readTemporaryExcludes,
  RELEASE_AGE_EXCEPTION_SOURCES,
} from "./check-stll-quarantine-excludes";
import type { AcceptanceTerms } from "./dependency-audit-acceptance";
import {
  EXTERNAL_CONTRACT_PIN_ALLOWANCES_PATH,
  readExternalContractPinAllowances,
  type ExternalContractPinAllowance,
} from "./external-contract-pin-allowances";
import { parseLedger } from "./suppression-waivers";

export const DAY_MS = 86_400_000;
export const WARNING_DAYS = 5;
// Network checks get three independent samples; test/rule probes get twenty
// to catch intermittent failures before removing their quarantine.
export const NETWORK_ATTEMPTS = 3;
export const TEST_ATTEMPTS = 20;
export type WaiverProbe = { command: readonly string[]; attempts: number };
/**
 * The documented zero-age override as one complete argument: `=` or any
 * spaces or tabs, then a zero that ends the argument (so `0.5` is not one).
 * Inventory and removal share it, so every inventoried spelling is removable.
 */
export const ZERO_AGE_OVERRIDE =
  /[ \t]--minimum-release-age(?:=|[ \t]+)0(?=$|[\s"'`;&|)])/u;

export const DOC_SOURCE_FILE = ".claude/mcp/doc-sources.ts";

export const RECHECK_INSTRUCTIONS = {
  "external-contract-pin":
    "Replay the offline SDK contract fixtures and remove the pin allowance.",
  "no-llms-txt": "Check canonical llms.txt and register an available source.",
  "release-age-exclusion":
    "Verify the pinned release passes the normal release-age gate, then remove the temporary exclusion.",
  "release-age-exception":
    "Recheck the release-age policy and remove the annotated exception.",
  "dependency-audit":
    "Re-run the dependency audit, check patched releases and dependency reachability; remove the acceptance.",
  "quarantined-test": "Run the quarantined test without its skip.",
  "suppression-waiver":
    "Recheck the suppression invariant and evidence; remove the suppression.",
} as const;

export type ProbeKind = keyof typeof RECHECK_INSTRUCTIONS;

export type DatedWaiver = {
  source: string;
  line: number;
  id: string;
  kind: ProbeKind;
  // Preserve the owner-written deadline; normalize only for evaluation.
  expiresAt: string;
  probe: WaiverProbe;
  checkedAt?: string;
};

// Date-only owners accept through the entire UTC day. Preserve that boundary.
export const expiryInstant = (date: string): string => {
  const instant = date.length === 10 ? `${date}T00:00:00.000Z` : date;
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== instant) {
    panic(`Invalid dated waiver expiry: ${date}`);
  }
  return date.length === 10 ? new Date(ms + DAY_MS).toISOString() : instant;
};

const sourceLine = (content: string, id: string): number => {
  const line = content
    .split("\n")
    .findIndex((value) => value.includes(JSON.stringify(id)));
  if (line === -1) {
    panic(`Dated waiver source anchor missing: ${id}`);
  }
  return line + 1;
};

type CollectWaiversOptions = {
  read: (file: string) => string;
  docs: readonly NoLlmsTxtExclusion[];
  audit: readonly AcceptanceTerms[];
  bunfigs: readonly string[];
  releaseAgeSources: Readonly<Record<string, string>>;
  quarantineSources?: Readonly<Record<string, string>>;
  externalContractPinAllowances?: readonly ExternalContractPinAllowance[];
};

export const collectWaivers = ({
  read,
  docs,
  audit,
  bunfigs,
  releaseAgeSources,
  quarantineSources = {},
  externalContractPinAllowances = [],
}: CollectWaiversOptions): DatedWaiver[] => {
  const entries: DatedWaiver[] = docs.map((entry) => ({
    source: DOC_SOURCE_FILE,
    line: sourceLine(read(DOC_SOURCE_FILE), entry.dependency),
    id: entry.dependency,
    kind: "no-llms-txt",
    expiresAt: entry.expiresAt,
    checkedAt: entry.checkedAt,
    probe: {
      command: [
        "bun",
        "scripts/dated-waiver-probes.ts",
        "--doc-url",
        /https:\/\/[^\s()]+\/llms\.txt\b/u.exec(entry.explanation)?.at(0) ?? "",
      ],
      attempts: NETWORK_ATTEMPTS,
    },
  }));
  for (const source of bunfigs) {
    const contents = read(source);
    const parsed = readTemporaryExcludes(contents);
    if (parsed.errors.length > 0) {
      panic(parsed.errors.join("\n"));
    }
    for (const entry of parsed.entries) {
      entries.push({
        source,
        line: sourceLine(contents, entry.name),
        id: entry.name,
        kind: "release-age-exclusion",
        probe: {
          command: [
            "bun",
            "scripts/check-lockfile-release-ages.ts",
            "--all",
            "--package",
            entry.name,
          ],
          attempts: NETWORK_ATTEMPTS,
        },
        expiresAt: entry.expiresAt,
      });
    }
  }
  const auditSource = "scripts/dependency-audit-baseline.json";
  for (const entry of audit) {
    if (entry.expiresOn === undefined) {
      continue;
    }
    entries.push({
      source: auditSource,
      line: sourceLine(read(auditSource), entry.id),
      id: entry.id,
      kind: "dependency-audit",
      probe: {
        command: ["bun", "run", "security:audit"],
        attempts: NETWORK_ATTEMPTS,
      },
      expiresAt: entry.expiresOn,
    });
  }
  const suppressionSource = "scripts/suppression-waivers.json";
  const ledger = parseLedger(JSON.parse(read(suppressionSource)));
  if (ledger.status === "invalid") {
    panic(ledger.errors.join("\n"));
  }
  for (const entry of ledger.ledger.waivers) {
    if (entry.kind === "permanent") {
      continue;
    }
    entries.push({
      source: suppressionSource,
      line: sourceLine(read(suppressionSource), entry.id),
      id: entry.id,
      kind: "suppression-waiver",
      probe: {
        command: [
          "bun",
          "--bun",
          "oxlint",
          "-c",
          "oxlint.config.ts",
          "--report-unused-disable-directives-severity=error",
          "--type-aware",
          entry.file,
        ],
        attempts: TEST_ATTEMPTS,
      },
      expiresAt: entry.expires,
    });
  }
  const exceptions = readReleaseAgeExceptions(releaseAgeSources);
  if (exceptions.errors.length > 0) {
    panic(exceptions.errors.join("\n"));
  }
  for (const entry of exceptions.entries) {
    // The command owns the waiver; line numbers only locate the annotation.
    const command = releaseAgeSources[entry.source]
      ?.split("\n")
      .at(entry.line - 2)
      ?.trim();
    if (entry.line < 2 || !command || !ZERO_AGE_OVERRIDE.test(command)) {
      panic(
        `Release-age exception has no covered zero-age command: ${entry.source}:${entry.line}`,
      );
    }
    entries.push({
      ...entry,
      id: command,
      kind: "release-age-exception",
      probe: {
        command: ["bun", "scripts/check-lockfile-release-ages.ts", "--all"],
        attempts: NETWORK_ATTEMPTS,
      },
    });
  }
  entries.push(...readTestQuarantines(quarantineSources));
  for (const allowance of externalContractPinAllowances) {
    entries.push({
      source: EXTERNAL_CONTRACT_PIN_ALLOWANCES_PATH,
      line: sourceLine(
        read(EXTERNAL_CONTRACT_PIN_ALLOWANCES_PATH),
        allowance.id,
      ),
      id: allowance.id,
      kind: "external-contract-pin",
      checkedAt: allowance.checkedAt,
      expiresAt: allowance.expiresAt,
      probe: {
        command: ["bun", "scripts/check-external-contracts.ts", "--check"],
        attempts: 1,
      },
    });
  }
  const identities = new Set<string>();
  for (const entry of entries) {
    expiryInstant(entry.expiresAt);
    const identity = JSON.stringify([entry.kind, entry.source, entry.id]);
    if (identities.has(identity)) {
      panic(`Duplicate dated waiver identity: ${entry.source}:${entry.id}`);
    }
    identities.add(identity);
  }
  return entries.toSorted(
    (a, b) =>
      compareCodeUnit(expiryInstant(a.expiresAt), expiryInstant(b.expiresAt)) ||
      compareCodeUnit(`${a.source}:${a.id}`, `${b.source}:${b.id}`),
  );
};

export const dueWaivers = (
  entries: readonly DatedWaiver[],
  now: Date,
  days = WARNING_DAYS,
): DatedWaiver[] =>
  entries.filter(
    (entry) =>
      Date.parse(expiryInstant(entry.expiresAt)) <=
      now.getTime() + days * DAY_MS,
  );

const escapeCommand = (value: string): string =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
export const waiverWarnings = (
  entries: readonly DatedWaiver[],
  now: Date,
): string[] =>
  dueWaivers(entries, now).map(
    (entry) =>
      `::warning file=${escapeCommand(entry.source).replaceAll(",", "%2C").replaceAll(":", "%3A")},line=${entry.line}::${escapeCommand(`${entry.id} (${entry.kind}) expires at ${entry.expiresAt}; ${RECHECK_INSTRUCTIONS[entry.kind]}`)}`,
  );

// An elapsed release-age exclusion is the owner's cleanup (dated-waiver-healing
// opens it), not a defect of whichever change is under review, so the
// per-change gate annotates it instead of failing every pull request and merge
// group. Every other elapsed waiver, including a dated test quarantine that
// still skips its test, keeps failing the gate.
const isExpired = (entry: DatedWaiver, now: Date): boolean =>
  Date.parse(expiryInstant(entry.expiresAt)) <= now.getTime();

export const expiredWaiverAnnotations = (
  entries: readonly DatedWaiver[],
  now: Date,
): string[] =>
  entries
    .filter(
      (entry) =>
        entry.kind === "release-age-exclusion" && isExpired(entry, now),
    )
    .map(
      (entry) =>
        `::warning file=${escapeCommand(entry.source).replaceAll(",", "%2C").replaceAll(":", "%3A")},line=${entry.line}::${escapeCommand(`${entry.id} (${entry.kind}) expired at ${entry.expiresAt}; ${RECHECK_INSTRUCTIONS[entry.kind]}`)}`,
    );

/**
 * Expired waivers that fail this check. A pull request or merge group passes
 * `changedFiles`: an expiry fails it only when the change touches the file that
 * declares the waiver (adding, renewing or editing it, or the waived code a
 * test quarantine sits on). Time alone never fails an unrelated change; the
 * scheduled run on the default branch checks every waiver and alerts owners.
 */
export const expiredWaiverFailures = (
  entries: readonly DatedWaiver[],
  now: Date,
  changedFiles?: ReadonlySet<string>,
): string[] =>
  entries
    .filter(
      (entry) =>
        entry.kind !== "release-age-exclusion" &&
        isExpired(entry, now) &&
        (changedFiles === undefined || changedFiles.has(entry.source)),
    )
    .map(
      (entry) =>
        `${entry.source}:${entry.line} dated waiver expired: ${entry.id}`,
    );

// A dated test quarantine is an adjacent comment on a literal test.skip/it.skip
// call. The inventory guard blocks at expiry even while the source still skips.
export const readTestQuarantines = (
  sources: Readonly<Record<string, string>>,
): DatedWaiver[] => {
  const entries: DatedWaiver[] = [];
  for (const [source, contents] of Object.entries(sources)) {
    const ast = ts.createSourceFile(
      source,
      contents,
      ts.ScriptTarget.Latest,
      true,
    );
    const consumed = new Set<number>();
    const markers = new Map<number, string>();
    const recordedComments = new Set<number>();
    const recordComments = (
      ranges: readonly ts.CommentRange[] | undefined,
    ): void => {
      for (const range of ranges ?? []) {
        if (recordedComments.has(range.pos)) {
          continue;
        }
        recordedComments.add(range.pos);
        const match = /test-quarantine-expires:\s*(\S+)/u.exec(
          contents.slice(range.pos, range.end),
        );
        if (match) {
          markers.set(range.pos, match.at(1) ?? "");
        }
      }
    };
    const collectComments = (node: ts.Node): void => {
      recordComments(ts.getLeadingCommentRanges(contents, node.getFullStart()));
      recordComments(ts.getTrailingCommentRanges(contents, node.getEnd()));
      ts.forEachChild(node, collectComments);
    };
    collectComments(ast);
    if (markers.size === 0) {
      continue;
    }
    const diagnostics =
      ts.transpileModule(contents, {
        fileName: source,
        reportDiagnostics: true,
      }).diagnostics ?? [];
    if (
      diagnostics.some(
        ({ category }) => category === ts.DiagnosticCategory.Error,
      )
    ) {
      panic(`Test quarantine owner does not parse: ${source}`);
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "skip" &&
        ["test", "it"].includes(node.expression.expression.getText(ast))
      ) {
        const markersHere = [...markers].filter(
          ([offset]) =>
            offset >= node.getFullStart() && offset < node.getStart(ast),
        );
        if (markersHere.length > 0) {
          const marker = markersHere.at(0);
          const title = node.arguments.at(0);
          if (
            markersHere.length !== 1 ||
            !marker ||
            !title ||
            !ts.isStringLiteral(title)
          ) {
            panic(
              `Test quarantine needs one literal test title and expiry: ${source}`,
            );
          }
          const [offset, expiresAt] = marker;
          expiryInstant(expiresAt);
          consumed.add(offset);
          const owner = /^(?:apps|packages)\/[^/]+/u.exec(source)?.at(0);
          const pattern = title.text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
          const relative = owner ? source.slice(owner.length + 1) : source;
          entries.push({
            source,
            line:
              ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
            id: title.text,
            kind: "quarantined-test",
            expiresAt,
            probe: {
              command: owner
                ? [
                    "bun",
                    `--cwd=${owner}`,
                    "run",
                    "test",
                    "--",
                    relative,
                    "-t",
                    pattern,
                  ]
                : ["bun", "test", source, "-t", pattern],
              attempts: TEST_ATTEMPTS,
            },
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (consumed.size !== markers.size) {
      panic(`Unowned dated test quarantine marker: ${source}`);
    }
  }
  return entries;
};

// Only expiry-bearing declarations in policy/config files enter the census.
// Ordinary timestamps, historical dates and runtime credential TTLs do not.
export const uncoveredExpirySources = (
  sources: Readonly<Record<string, string>>,
  covered: ReadonlySet<string>,
): string[] =>
  Object.entries(sources)
    .filter(
      ([file, content]) =>
        !covered.has(file) &&
        /(?:["']?(?:expiresAt|expiresOn|expires|expires_at|expires_on|expires-at|reviewBy|review-by|until|EXPIRES_AT)["']?\s*[:=]\s*["']?\d{4}-\d{2}-\d{2}|(?:quarantine-expires|release-age-quarantine-exception):\s*\d{4}-\d{2}-\d{2})/u.test(
          content,
        ),
    )
    .map(([file]) => file);

export const readTrackedPolicyFiles = (file: string): string[] => {
  const contents = readFileSync(file, "utf-8");
  if (contents.length === 0 || !contents.endsWith("\0")) {
    panic("Tracked-files input must be a non-empty NUL-separated path list");
  }
  const files = contents.slice(0, -1).split("\0");
  for (const trackedFile of files) {
    if (
      trackedFile.length === 0 ||
      path.posix.isAbsolute(trackedFile) ||
      path.win32.isAbsolute(trackedFile) ||
      trackedFile.split("/").includes("..")
    ) {
      panic(`Invalid tracked-file path: ${trackedFile || "<empty>"}`);
    }
  }
  return files;
};

export const loadWaivers = (tracked: readonly string[]): DatedWaiver[] => {
  const root = path.resolve(import.meta.dir, "..");
  const read = (file: string): string =>
    readFileSync(path.join(root, file), "utf-8");
  const files = tracked.filter(
    (file) => file === "bunfig.toml" || file.endsWith("/bunfig.toml"),
  );
  const policyFiles = tracked.filter(
    (file) =>
      /(?:^(?:scripts\/|\.claude\/mcp\/|\.oxlint-plugins\/|\.github\/)|config|baseline|waivers|allowances|bunfig\.toml$)/u.test(
        file,
      ) &&
      /\.(?:ts|json|toml|ya?ml)$/u.test(file) &&
      !/(?:\.test\.|\.spec\.|fixtures\/|__fixtures__\/)/u.test(file),
  );
  const uncovered = uncoveredExpirySources(
    Object.fromEntries(policyFiles.map((file) => [file, read(file)])),
    new Set([
      DOC_SOURCE_FILE,
      "scripts/suppression-waivers.ts",
      "scripts/suppression-waivers.json",
      "scripts/dependency-audit-baseline.json",
      EXTERNAL_CONTRACT_PIN_ALLOWANCES_PATH,
      ...RELEASE_AGE_EXCEPTION_SOURCES,
      ...files,
    ]),
  );
  if (uncovered.length > 0) {
    panic(`Unregistered dated waiver owners: ${uncovered.join(", ")}`);
  }
  const configSources = Object.fromEntries(
    RELEASE_AGE_EXCEPTION_SOURCES.map((file) => [file, read(file)]),
  );
  const auditBaseline: unknown = JSON.parse(
    read("scripts/dependency-audit-baseline.json"),
  );
  const audit =
    typeof auditBaseline === "object" &&
    auditBaseline !== null &&
    "accepted" in auditBaseline &&
    Array.isArray(auditBaseline.accepted)
      ? auditBaseline.accepted.filter(
          (entry): entry is AcceptanceTerms =>
            typeof entry === "object" &&
            entry !== null &&
            "id" in entry &&
            typeof entry.id === "string" &&
            "package" in entry &&
            typeof entry.package === "string",
        )
      : [];
  return collectWaivers({
    read,
    externalContractPinAllowances: readExternalContractPinAllowances(
      read(EXTERNAL_CONTRACT_PIN_ALLOWANCES_PATH),
    ),
    docs: DOC_SOURCE_EXCLUSIONS,
    audit,
    bunfigs: files,
    releaseAgeSources: configSources,
    quarantineSources: Object.fromEntries(
      tracked
        .filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file))
        .map((file) => [file, read(file)] as const)
        .filter(([, content]) => content.includes("test-quarantine-expires:")),
    ),
  });
};

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const trackedFilesFlag = process.argv.indexOf("--tracked-files");
  if (check && trackedFilesFlag === -1) {
    panic("--check requires --tracked-files <NUL-separated-file>");
  }
  const trackedFilesPath =
    trackedFilesFlag === -1 ? undefined : process.argv.at(trackedFilesFlag + 1);
  // NUL-separated paths the change touches; absent on the scheduled full check.
  const changedFilesFlag = process.argv.indexOf("--changed-files");
  const changedFilesPath =
    changedFilesFlag === -1 ? undefined : process.argv.at(changedFilesFlag + 1);
  if (changedFilesFlag !== -1 && !changedFilesPath) {
    panic("--changed-files requires a path");
  }
  if (trackedFilesFlag !== -1 && !trackedFilesPath) {
    panic("--tracked-files requires a path");
  }
  if (trackedFilesPath === undefined) {
    panic("Inventory modes require --tracked-files <NUL-separated-file>");
  }
  const entries = loadWaivers(readTrackedPolicyFiles(trackedFilesPath));
  if (check) {
    const now = new Date();
    for (const annotation of expiredWaiverAnnotations(entries, now)) {
      console.log(annotation);
    }
    const changedFiles =
      changedFilesPath === undefined
        ? undefined
        : new Set(
            readFileSync(changedFilesPath, "utf-8")
              .split("\0")
              .filter((file) => file !== ""),
          );
    const failures = expiredWaiverFailures(entries, now, changedFiles);
    if (failures.length > 0) {
      console.error(failures.join("\n"));
      process.exitCode = 1;
    }
  } else if (process.argv.includes("--due")) {
    console.log(dueWaivers(entries, new Date()).length > 0);
  } else if (process.argv.includes("--warn")) {
    for (const warning of waiverWarnings(entries, new Date())) {
      console.log(warning);
    }
  } else {
    console.log(JSON.stringify(entries, null, 2));
  }
}
