// Add each new dated exception at its owner, then register its adapter here.
// The census covers policy/config expiry keys; prose-only review promises need
// an explicit adapter (see docs/maintenance/dated-waivers.md).
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import { compareCodeUnit } from "@stll/collation";

import {
  DOC_SOURCE_EXCLUSIONS,
  type NoLlmsTxtExclusion,
} from "../.claude/mcp/doc-sources";
import { PENDING_CONTRACT_MIGRATIONS } from "../apps/api/src/lib/db/pending-contract-migrations/registry";
import {
  readReleaseAgeExceptions,
  readTemporaryExcludes,
  RELEASE_AGE_EXCEPTION_SOURCES,
} from "./check-stll-quarantine-excludes";
import type { AcceptanceTerms } from "./dependency-audit-acceptance";
import {
  parseRegistry,
  type QuarantineEntry,
  REGISTRY_FILE as FLAKY_TEST_QUARANTINE_FILE,
  splitTestId,
} from "./flaky-test-quarantine";
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
export const PENDING_CONTRACT_MIGRATIONS_SOURCE =
  "apps/api/src/lib/db/pending-contract-migrations/registry.ts";

export const RECHECK_INSTRUCTIONS = {
  "no-llms-txt": "Check canonical llms.txt and register an available source.",
  "release-age-exclusion":
    "Verify the pinned release passes the normal release-age gate, then remove the temporary exclusion.",
  "release-age-exception":
    "Recheck the release-age policy and remove the annotated exception.",
  "dependency-audit":
    "Re-run the dependency audit, check patched releases and dependency reachability; remove the acceptance.",
  "quarantined-test": "Run the quarantined test without its skip.",
  "flaky-test-quarantine":
    "Run the test without its quarantine entry, fix its flake, and remove the entry.",
  "suppression-waiver":
    "Recheck the suppression invariant and evidence; remove the suppression.",
  "pending-contract-migration":
    "Ship the contract step as a drizzle migration once its older readers are retired, or renew the deadline with the reason in review.",
} as const;

export type ProbeKind = keyof typeof RECHECK_INSTRUCTIONS;

/**
 * The llms.txt URL a documentation waiver's recheck probes: the first one its
 * explanation names, or "" when it names none and so cannot be rechecked.
 */
export const docProbeUrl = (explanation: string): string =>
  /https:\/\/[^\s()]+\/llms\.txt\b/u.exec(explanation)?.at(0) ?? "";

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
  flakyTestQuarantines?: readonly QuarantineEntry[];
  pendingContractMigrations?: readonly {
    name: string;
    expiresAt: string;
  }[];
};

export const collectWaivers = ({
  read,
  docs,
  audit,
  bunfigs,
  releaseAgeSources,
  quarantineSources = {},
  flakyTestQuarantines = [],
  pendingContractMigrations = [],
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
        docProbeUrl(entry.explanation),
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
  for (const entry of flakyTestQuarantines) {
    const identity =
      splitTestId(entry.id) ??
      panic(`Invalid flaky-test quarantine id: ${entry.id}`);
    entries.push({
      source: FLAKY_TEST_QUARANTINE_FILE,
      line: sourceLine(read(FLAKY_TEST_QUARANTINE_FILE), entry.id),
      id: entry.id,
      kind: "flaky-test-quarantine",
      expiresAt: entry.expires,
      probe: {
        // Filtered by the test's own title (the last describe segment); the
        // probe receipt then requires its full name to pass.
        command: testProbeCommand({
          file: identity.file,
          title: identity.name.split(" > ").at(-1) ?? identity.name,
        }),
        attempts: TEST_ATTEMPTS,
      },
    });
  }
  const pendingSource = read(PENDING_CONTRACT_MIGRATIONS_SOURCE);
  for (const entry of pendingContractMigrations) {
    entries.push({
      source: PENDING_CONTRACT_MIGRATIONS_SOURCE,
      line: sourceLine(pendingSource, entry.name),
      id: entry.name,
      kind: "pending-contract-migration",
      expiresAt: entry.expiresAt,
      probe: {
        command: ["test", "-d", `apps/api/drizzle/${entry.name}`],
        attempts: TEST_ATTEMPTS,
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

// How the per-change gate treats an elapsed waiver. An elapsed release-age
// exclusion is the owner's cleanup (dated-waiver-healing opens it) and stops
// exempting new pins in scripts/check-lockfile-release-ages.ts, and an
// elapsed flaky-test quarantine is enforced on main by the scheduled
// flaky-test-quarantine workflow, which fails naming its owner: neither is a defect
// of whichever change is under review, so pull requests and merge groups only
// annotate them. Dependency acceptance dates warn unless their source changes.
// Every other elapsed waiver, including a dated test quarantine
// that still skips its test, keeps failing the gate.
export const EXPIRY_AT_CHANGE_GATE = {
  "no-llms-txt": "fail",
  "release-age-exclusion": "annotate",
  "release-age-exception": "fail",
  "dependency-audit": "fail",
  "quarantined-test": "fail",
  "flaky-test-quarantine": "annotate",
  "suppression-waiver": "fail",
  "pending-contract-migration": "fail",
} as const satisfies Record<ProbeKind, "annotate" | "fail">;

const isExpired = (entry: DatedWaiver, now: Date): boolean =>
  Date.parse(expiryInstant(entry.expiresAt)) <= now.getTime();

export const expiredWaiverAnnotations = (
  entries: readonly DatedWaiver[],
  now: Date,
): string[] =>
  entries
    .filter(
      (entry) =>
        EXPIRY_AT_CHANGE_GATE[entry.kind] === "annotate" &&
        isExpired(entry, now),
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
 * scheduled run checks other waivers; dependency acceptance dates remain warnings
 * until a change touches the acceptance file.
 */
export const expiredWaiverFailures = (
  entries: readonly DatedWaiver[],
  now: Date,
  changedFiles?: ReadonlySet<string>,
): string[] =>
  entries
    .filter(
      (entry) =>
        EXPIRY_AT_CHANGE_GATE[entry.kind] === "fail" &&
        isExpired(entry, now) &&
        (entry.kind === "dependency-audit"
          ? changedFiles?.has(entry.source) === true
          : changedFiles === undefined || changedFiles.has(entry.source)),
    )
    .map(
      (entry) =>
        `${entry.source}:${entry.line} dated waiver expired: ${entry.id}`,
    );

/**
 * Due waivers this check neither fails nor already annotates: each warns on
 * the file declaring it from WARNING_DAYS before its expiry, so the owner
 * renews or removes it before the date, and keeps warning after the date on
 * changes that do not touch that file.
 */
export const dueWaiverWarnings = (
  entries: readonly DatedWaiver[],
  now: Date,
  changedFiles?: ReadonlySet<string>,
): string[] =>
  waiverWarnings(
    entries.filter(
      (entry) =>
        !isExpired(entry, now) ||
        (EXPIRY_AT_CHANGE_GATE[entry.kind] === "fail" &&
          (entry.kind === "dependency-audit"
            ? changedFiles?.has(entry.source) !== true
            : changedFiles !== undefined && !changedFiles.has(entry.source))),
    ),
    now,
  );

// Runs one test through its owning package script, filtered by its title.
type TestProbeOptions = { file: string; title: string };
const testProbeCommand = ({
  file,
  title,
}: TestProbeOptions): readonly string[] => {
  const owner = /^(?:apps|packages)\/[^/]+/u.exec(file)?.at(0);
  const pattern = title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const relative = owner ? file.slice(owner.length + 1) : file;
  return owner
    ? ["bun", `--cwd=${owner}`, "run", "test", "--", relative, "-t", pattern]
    : ["bun", "test", file, "-t", pattern];
};

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
          entries.push({
            source,
            line:
              ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
            id: title.text,
            kind: "quarantined-test",
            expiresAt,
            probe: {
              command: testProbeCommand({ file: source, title: title.text }),
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

// Expiry-bearing declarations in policy/config files and application/package
// source enter the census. Ordinary timestamps and historical dates do not.
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

const flakyTestQuarantines = (content: string): readonly QuarantineEntry[] => {
  const parsed = parseRegistry(JSON.parse(content));
  return parsed.status === "valid"
    ? parsed.registry.entries
    : panic(parsed.errors.join("\n"));
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
      ((/^(?:apps|packages)\//u.test(file) &&
        /\.(?:[cm]?tsx?|json)$/u.test(file)) ||
        (/(?:^(?:scripts\/|\.claude\/mcp\/|\.oxlint-plugins\/|\.github\/)|config|baseline|waivers|allowances|bunfig\.toml$)/u.test(
          file,
        ) &&
          /\.(?:ts|json|toml|ya?ml)$/u.test(file))) &&
      !/(?:\.test\.|\.spec\.|fixtures\/|__fixtures__\/)/u.test(file),
  );
  const uncovered = uncoveredExpirySources(
    Object.fromEntries(policyFiles.map((file) => [file, read(file)])),
    new Set([
      DOC_SOURCE_FILE,
      FLAKY_TEST_QUARANTINE_FILE,
      "scripts/suppression-waivers.ts",
      "scripts/suppression-waivers.json",
      "scripts/dependency-audit-baseline.json",
      PENDING_CONTRACT_MIGRATIONS_SOURCE,
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
    docs: DOC_SOURCE_EXCLUSIONS,
    audit,
    bunfigs: files,
    releaseAgeSources: configSources,
    flakyTestQuarantines: flakyTestQuarantines(
      read(FLAKY_TEST_QUARANTINE_FILE),
    ),
    pendingContractMigrations: PENDING_CONTRACT_MIGRATIONS,
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
    for (const warning of dueWaiverWarnings(entries, now, changedFiles)) {
      console.log(warning);
    }
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
