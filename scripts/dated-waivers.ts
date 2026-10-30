// Add each new dated exception at its owner, then register its adapter here.
// The census covers policy/config expiry keys; prose-only review promises need
// an explicit adapter (see docs/maintenance/dated-waivers.md).
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as v from "valibot";

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
import {
  DAY_MS,
  DOC_SOURCE_FILE,
  expiryInstant,
  readTestQuarantines,
  TEST_ATTEMPTS,
  testProbeCommand,
  ZERO_AGE_OVERRIDE,
} from "./dated-waiver-core";
import { waiverEntryFields } from "./dated-waiver-entry";
import { waiverKey } from "./dated-waiver-fix-task";
import type { AcceptanceTerms } from "./dependency-audit-acceptance";
import {
  parseRegistry,
  type QuarantineEntry,
  REGISTRY_FILE as FLAKY_TEST_QUARANTINE_FILE,
  splitTestId,
} from "./flaky-test-quarantine";
import {
  GUARD_ROLLOUTS,
  type GuardRollout,
  guardRolloutSource,
} from "./guard-rollout-policy.ts";
import { parseLedger } from "./suppression-waivers";

export const WARNING_DAYS = 5;
// Network checks get three independent samples; test/rule probes get twenty
// to catch intermittent failures before removing their quarantine.
export const NETWORK_ATTEMPTS = 3;
export type WaiverProbe = { command: readonly string[]; attempts: number };
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
  "guard-rollout":
    "Run the full guard and remove its temporary changed-lines scope.",
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
  guardRollouts?: readonly GuardRollout[];
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
  guardRollouts = [],
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
  for (const rollout of guardRollouts) {
    if (rollout.type !== "changed-lines") {
      continue;
    }
    const source = guardRolloutSource(rollout.id);
    entries.push({
      source,
      line: sourceLine(read(source), rollout.id),
      id: rollout.id,
      kind: "guard-rollout",
      expiresAt: rollout.expiresAt,
      probe: {
        command: ["env", "STELLA_GUARD_SCOPE=all", ...rollout.check],
        attempts: TEST_ATTEMPTS,
      },
    });
  }
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

// Main keeps the existing per-kind enforcement owners. Every expired entry
// added or edited by a change fails that change, including annotate-only kinds.
export const EXPIRY_AT_CHANGE_GATE = {
  "no-llms-txt": "fail",
  "release-age-exclusion": "annotate",
  "release-age-exception": "fail",
  "dependency-audit": "fail",
  "quarantined-test": "fail",
  "guard-rollout": "fail",
  "flaky-test-quarantine": "annotate",
  "suppression-waiver": "fail",
  "pending-contract-migration": "fail",
} as const satisfies Record<ProbeKind, "annotate" | "fail">;

const isExpired = (entry: DatedWaiver, now: Date): boolean =>
  Date.parse(expiryInstant(entry.expiresAt)) <= now.getTime();

export const expiredWaiverAnnotations = (
  entries: readonly DatedWaiver[],
  now: Date,
  changedEntries?: ReadonlySet<string>,
): string[] =>
  entries
    .filter(
      (entry) =>
        !changedEntries?.has(waiverKey(entry)) &&
        EXPIRY_AT_CHANGE_GATE[entry.kind] === "annotate" &&
        isExpired(entry, now),
    )
    .map(
      (entry) =>
        `::warning file=${escapeCommand(entry.source).replaceAll(",", "%2C").replaceAll(":", "%3A")},line=${entry.line}::${escapeCommand(`${entry.id} (${entry.kind}) expired at ${entry.expiresAt}; ${RECHECK_INSTRUCTIONS[entry.kind]}`)}`,
    );

type ChangedWaiverKeysOptions = {
  entries: readonly DatedWaiver[];
  changedFiles: ReadonlySet<string>;
  read: (file: string) => string;
  baseSources: Readonly<Record<string, string>>;
};

export const changedWaiverKeys = ({
  entries,
  changedFiles,
  read,
  baseSources,
}: ChangedWaiverKeysOptions): ReadonlySet<string> =>
  new Set(
    entries
      .filter((entry) => {
        if (!changedFiles.has(entry.source)) {
          return false;
        }
        const current = waiverEntryFields(entry, read(entry.source));
        if (current === undefined) {
          panic(`Dated waiver entry missing: ${entry.source}:${entry.id}`);
        }
        const base = baseSources[entry.source];
        return (
          base === undefined ||
          !isDeepStrictEqual(current, waiverEntryFields(entry, base))
        );
      })
      .map(waiverKey),
  );

const failsExpiry = (
  entry: DatedWaiver,
  changedEntries?: ReadonlySet<string>,
): boolean =>
  changedEntries === undefined
    ? EXPIRY_AT_CHANGE_GATE[entry.kind] === "fail" &&
      entry.kind !== "dependency-audit"
    : changedEntries.has(waiverKey(entry));

/** An absent change scope is the full default-branch check. */
export const expiredWaiverFailures = (
  entries: readonly DatedWaiver[],
  now: Date,
  changedEntries?: ReadonlySet<string>,
): string[] =>
  entries
    .filter(
      (entry) => isExpired(entry, now) && failsExpiry(entry, changedEntries),
    )
    .map(
      (entry) =>
        `${entry.source}:${entry.line} dated waiver expired: ${entry.id}`,
    );

/** Untouched expired entries keep warning, including siblings in edited files. */
export const dueWaiverWarnings = (
  entries: readonly DatedWaiver[],
  now: Date,
  changedEntries?: ReadonlySet<string>,
): string[] =>
  waiverWarnings(
    entries.filter(
      (entry) =>
        !isExpired(entry, now) ||
        (!failsExpiry(entry, changedEntries) &&
          EXPIRY_AT_CHANGE_GATE[entry.kind] === "fail"),
    ),
    now,
  );

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
      ...GUARD_ROLLOUTS.map(({ id }) => guardRolloutSource(id)),
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
    guardRollouts: GUARD_ROLLOUTS,
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
    const changedFiles =
      changedFilesPath === undefined
        ? undefined
        : new Set(
            readFileSync(changedFilesPath, "utf-8")
              .split("\0")
              .filter((file) => file !== ""),
          );
    const baseFilesFlag = process.argv.indexOf("--base-files");
    const baseFilesPath =
      baseFilesFlag === -1 ? undefined : process.argv.at(baseFilesFlag + 1);
    if (baseFilesFlag !== -1 && !baseFilesPath) {
      panic("--base-files requires a path");
    }
    if (
      changedFiles !== undefined &&
      changedFiles.size > 0 &&
      baseFilesPath === undefined
    ) {
      panic("--changed-files requires --base-files for a non-empty change");
    }
    const baseSources =
      baseFilesPath === undefined
        ? {}
        : v.parse(
            v.record(v.string(), v.string()),
            JSON.parse(readFileSync(baseFilesPath, "utf-8")),
          );
    const changedEntries =
      changedFiles === undefined
        ? undefined
        : changedWaiverKeys({
            entries,
            changedFiles,
            baseSources,
            read: (file) =>
              readFileSync(path.resolve(import.meta.dir, "..", file), "utf-8"),
          });
    for (const annotation of expiredWaiverAnnotations(
      entries,
      now,
      changedEntries,
    )) {
      console.log(annotation);
    }
    for (const warning of dueWaiverWarnings(entries, now, changedEntries)) {
      console.log(warning);
    }
    const failures = expiredWaiverFailures(entries, now, changedEntries);
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

export {
  DAY_MS,
  DOC_SOURCE_FILE,
  expiryInstant,
  readTestQuarantines,
  TEST_ATTEMPTS,
  ZERO_AGE_OVERRIDE,
} from "./dated-waiver-core";
