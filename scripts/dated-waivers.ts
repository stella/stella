// Add each new dated exception at its owner, then register its adapter here.
// The census covers policy/config expiry keys; prose-only review promises need
// an explicit adapter (see docs/maintenance/dated-waivers.md).
import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { sha256Hex } from "@stll/sha256/bun";

import {
  DOC_SOURCE_EXCLUSIONS,
  type NoLlmsTxtExclusion,
} from "../.claude/mcp/doc-sources";
import {
  quarantineBunfigFiles,
  quarantineOwningFiles,
  readReleaseAgeExceptions,
  readTemporaryExcludes,
  RELEASE_AGE_EXCEPTION_SOURCES,
} from "./check-stll-quarantine-excludes";
import type { AcceptanceTerms } from "./dependency-audit-acceptance";
import { expiryBlocksFiles, type ExpiryCheckScope } from "./expiry-check-scope";
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

/** The stable identity of one dated exception entry. */
export const waiverKey = (
  entry: Pick<DatedWaiver, "kind" | "source" | "id">,
): string =>
  sha256Hex(JSON.stringify([entry.kind, entry.source, entry.id])).slice(0, 24);

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
};

export const collectWaivers = ({
  read,
  docs,
  audit,
  bunfigs,
  releaseAgeSources,
  quarantineSources = {},
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
        line:
          contents
            .split("\n")
            .findIndex(
              (line) =>
                line.includes(JSON.stringify(entry.name)) &&
                line.includes(entry.expiresAt),
            ) + 1,
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

/** Versioned, read-only contract for expiry radar consumers. Probe results are
 * deliberately not inferred from the clock for exceptions with external causes. */
export const exceptionInventory = (
  entries: readonly DatedWaiver[],
  now: Date,
) => ({
  schemaVersion: 1,
  entries: entries.map((entry) => ({
    kind: entry.kind,
    file: entry.source,
    entry: entry.id,
    expiryInstant: expiryInstant(entry.expiresAt),
    owner: entry.source,
    canRemoveYet:
      entry.kind === "release-age-exclusion"
        ? now.getTime() >= Date.parse(expiryInstant(entry.expiresAt))
        : null,
    removal:
      entry.kind === "release-age-exclusion" ? "at-expiry" : "requires-probe",
    probe: entry.probe,
  })),
});

export const withinHours = (value: string): number => {
  if (!/^\d+h$/u.test(value)) {
    return panic("--within requires a whole number of hours, for example 72h");
  }
  const hours = Number(value.slice(0, -1));
  if (!Number.isSafeInteger(hours)) {
    return panic("--within hours exceed the supported range");
  }
  return hours;
};

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

const isExpired = (entry: DatedWaiver, now: Date): boolean =>
  Date.parse(expiryInstant(entry.expiresAt)) <= now.getTime();

type WaiverExpiryScope = {
  scope: ExpiryCheckScope;
  packageManifests?: Readonly<Record<string, string>>;
  basePackageManifests?: Readonly<Record<string, string>>;
};
const ALL_WAIVER_EXPIRIES = {
  scope: { type: "all" },
} as const satisfies WaiverExpiryScope;
const waiverBlocks = (entry: DatedWaiver, context: WaiverExpiryScope) =>
  expiryBlocksFiles(
    context.scope,
    entry.kind === "release-age-exclusion"
      ? quarantineOwningFiles({
          bunfigFile: entry.source,
          packageName: entry.id,
          packageManifests: context.packageManifests,
          basePackageManifests: context.basePackageManifests,
        })
      : [entry.source],
  );

export const expiredWaiverAnnotations = (
  entries: readonly DatedWaiver[],
  now: Date,
  context: WaiverExpiryScope = ALL_WAIVER_EXPIRIES,
): string[] =>
  entries
    .filter((entry) => isExpired(entry, now) && !waiverBlocks(entry, context))
    .map(
      (entry) =>
        `::warning file=${escapeCommand(entry.source).replaceAll(",", "%2C").replaceAll(":", "%3A")},line=${entry.line}::${escapeCommand(`${entry.id} (${entry.kind}) expired at ${entry.expiresAt}; ${RECHECK_INSTRUCTIONS[entry.kind]}`)}`,
    );

export const expiredWaiverFailures = (
  entries: readonly DatedWaiver[],
  now: Date,
  context: WaiverExpiryScope = ALL_WAIVER_EXPIRIES,
): string[] =>
  entries
    .filter((entry) => isExpired(entry, now) && waiverBlocks(entry, context))
    .map(
      (entry) =>
        `${entry.source}:${entry.line} dated waiver expired: ${entry.id}`,
    );

/** Removing an exclusion early blocks even when the head no longer inventories it. */
export const prematureExclusionRemovals = (
  baseBunfigs: Readonly<Record<string, string>>,
  headBunfigs: Readonly<Record<string, string>>,
  now: Date,
): string[] =>
  Object.entries(baseBunfigs).flatMap(([source, before]) => {
    const base = readTemporaryExcludes(before);
    if (base.errors.length > 0) {
      return panic(base.errors.join("\n"));
    }
    const remaining = readTemporaryExcludes(headBunfigs[source] ?? "");
    if (remaining.errors.length > 0) {
      return panic(remaining.errors.join("\n"));
    }
    return base.entries
      .filter(
        (entry) =>
          now.getTime() < Date.parse(entry.expiresAt) &&
          !remaining.entries.some((candidate) => candidate.name === entry.name),
      )
      .map(
        (entry) =>
          `${source}: ${entry.name} cannot be removed before release-age expiry ${entry.expiresAt}`,
      );
  });

const waiverReferenceSchema = v.object({
  kind: v.picklist(
    Object.keys(RECHECK_INSTRUCTIONS).filter((kind): kind is ProbeKind =>
      Object.hasOwn(RECHECK_INSTRUCTIONS, kind),
    ),
  ),
  source: v.string(),
  id: v.string(),
  expiresAt: v.string(),
});
export type WaiverReference = v.InferOutput<typeof waiverReferenceSchema>;
const proposalSchema = v.object({
  schemaVersion: v.literal(1),
  kind: v.literal("extension"),
  entries: v.array(waiverReferenceSchema),
  ownerReason: v.string(),
});
const recordsDeadline = (
  inventory: readonly WaiverReference[] | null,
  reference: WaiverReference,
): boolean =>
  inventory?.some(
    (entry) =>
      entry.kind === reference.kind &&
      entry.source === reference.source &&
      entry.id === reference.id &&
      expiryInstant(entry.expiresAt) === expiryInstant(reference.expiresAt),
  ) ?? false;
// A new proposal in a change must name a deadline the base inventory records.
const changesNewProposal = (
  scope: ExpiryCheckScope | undefined,
  inventory: readonly WaiverReference[] | null,
  reference: WaiverReference,
): boolean =>
  scope?.type === "changes" && !recordsDeadline(inventory, reference);
type ExtensionProposalOptions = {
  proposals: Readonly<Record<string, string>>;
  entries: readonly DatedWaiver[];
  body?: string | undefined;
  scope?: ExpiryCheckScope;
  baseProposals?: Readonly<Record<string, string>>;
  /** The base inventory, when the change adds a proposal. */
  baseEntries?: readonly WaiverReference[] | null;
};
export const extensionProposalFailures = ({
  proposals,
  entries,
  body,
  scope,
  baseProposals = {},
  baseEntries = null,
}: ExtensionProposalOptions): string[] =>
  Object.entries(proposals).flatMap(([file, contents]) => {
    const proposal = v.parse(proposalSchema, JSON.parse(contents));
    const baseContents = baseProposals[file];
    const base =
      baseContents === undefined
        ? undefined
        : v.parse(proposalSchema, JSON.parse(baseContents));
    const reason = proposal.ownerReason.trim();
    const placeholder =
      /^(?:OWNER_REASON_REQUIRED|REQUIRED|TODO|TBD|placeholder)?$/iu;
    const errors: string[] = [];
    const original = proposal.entries.at(0);
    if (
      proposal.entries.length !== 1 ||
      !original ||
      original.kind === "release-age-exclusion" ||
      file !== `.github/dated-exception-proposals/${waiverKey(original)}.json`
    ) {
      errors.push(
        `${file}: extension entries must match their generated proposal identity`,
      );
    }
    if (
      base &&
      JSON.stringify(base.entries) !== JSON.stringify(proposal.entries)
    ) {
      errors.push(`${file}: original extension entries are immutable`);
    }
    if (reason.length < 12 || placeholder.test(reason)) {
      errors.push(`${file}: owner-reason: requires an explicit owner reason`);
    }
    if (
      body !== undefined &&
      (scope === undefined ||
        scope.type === "all" ||
        scope.changedFiles.has(file))
    ) {
      const bodyReason =
        /^owner-reason:(.*)$/mu.exec(body)?.at(1)?.trim() ?? "";
      if (bodyReason !== reason) {
        errors.push(
          `${file}: PR body owner-reason: must match the recorded owner reason`,
        );
      }
    }
    for (const reference of proposal.entries) {
      // Without a base proposal, the reference must be the deadline the base
      // inventory records; otherwise an unchanged deadline could pass as an
      // explicit change.
      if (
        base === undefined &&
        changesNewProposal(scope, baseEntries, reference)
      ) {
        errors.push(
          `${file}: a new extension must reference its base inventory deadline`,
        );
      }
      const current = entries.find(
        (entry) =>
          entry.kind === reference.kind &&
          entry.source === reference.source &&
          entry.id === reference.id,
      );
      if (
        current &&
        expiryInstant(current.expiresAt) === expiryInstant(reference.expiresAt)
      ) {
        errors.push(
          `${file}: owner must resolve the exception or explicitly change its expiry`,
        );
      }
      const established =
        base !== undefined &&
        base.ownerReason.trim().length >= 12 &&
        !placeholder.test(base.ownerReason.trim());
      if (
        scope?.type === "changes" &&
        !scope.changedFiles.has(reference.source) &&
        !established
      ) {
        errors.push(
          `${file}: resolving an extension requires a change to its owning source`,
        );
      }
    }
    return errors;
  });

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

const readWorkingTree = (file: string): string =>
  readFileSync(path.join(import.meta.dir, "..", file), "utf-8");

export const loadWaivers = (
  tracked: readonly string[],
  read: (file: string) => string = readWorkingTree,
): DatedWaiver[] => {
  const files = quarantineBunfigFiles(tracked);
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
      ...tracked.filter((file) =>
        file.startsWith(".github/dated-exception-proposals/"),
      ),
      "scripts/suppression-waivers.ts",
      "scripts/suppression-waivers.json",
      "scripts/dependency-audit-baseline.json",
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
    quarantineSources: Object.fromEntries(
      tracked
        .filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file))
        .map((file) => [file, read(file)] as const)
        .filter(([, content]) => content.includes("test-quarantine-expires:")),
    ),
  });
};

export const contextSchema = v.object({
  scope: v.variant("type", [
    v.object({ type: v.literal("all") }),
    v.object({
      type: v.literal("changes"),
      baseSha: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/u)),
      changedFiles: v.array(v.string()),
    }),
  ]),
  baseBunfigs: v.record(v.string(), v.string()),
  basePackageManifests: v.record(v.string(), v.string()),
  baseProposals: v.record(v.string(), v.string()),
  baseEntries: v.nullable(v.array(waiverReferenceSchema)),
});
if (import.meta.main) {
  const trackedFilesFlag = process.argv.indexOf("--tracked-files");
  const trackedFilesPath =
    trackedFilesFlag === -1 ? undefined : process.argv.at(trackedFilesFlag + 1);
  // The offline check only reads prepared files; preparing and listing need
  // git and live in dated-waiver-inventory.ts.
  if (!process.argv.includes("--check") || !trackedFilesPath) {
    panic("--check requires --tracked-files <NUL-separated-file>");
  }
  const entries = loadWaivers(readTrackedPolicyFiles(trackedFilesPath));
  const now = new Date();
  const contextFile = `${trackedFilesPath}.context.json`;
  if (process.env["GITHUB_ACTIONS"] === "true" && !existsSync(contextFile)) {
    panic("CI expiry check requires prepared context");
  }
  const context = existsSync(contextFile)
    ? v.parse(contextSchema, JSON.parse(readFileSync(contextFile, "utf-8")))
    : {
        scope: { type: "all" as const },
        baseBunfigs: {},
        basePackageManifests: {},
        baseProposals: {},
        baseEntries: null,
      };
  const read = (file: string) =>
    readFileSync(path.join(import.meta.dir, "..", file), "utf-8");
  const packageManifests = Object.fromEntries(
    tracked
      .filter(
        (file) => file === "package.json" || file.endsWith("/package.json"),
      )
      .map((file) => [file, read(file)]),
  );
  const expiryContext = {
    scope:
      context.scope.type === "all"
        ? context.scope
        : {
            type: "changes" as const,
            changedFiles: new Set(context.scope.changedFiles),
            baseSha: context.scope.baseSha,
          },
    packageManifests,
    basePackageManifests: context.basePackageManifests,
  };
  for (const annotation of expiredWaiverAnnotations(
    entries,
    now,
    expiryContext,
  )) {
    console.log(annotation);
  }
  const event = process.env["GITHUB_EVENT_PATH"]
    ? v.parse(
        v.object({
          pull_request: v.optional(v.object({ body: v.nullish(v.string()) })),
        }),
        JSON.parse(readFileSync(process.env["GITHUB_EVENT_PATH"], "utf-8")),
      )
    : undefined;
  const failures = [
    ...expiredWaiverFailures(entries, now, expiryContext),
    ...prematureExclusionRemovals(
      context.baseBunfigs,
      Object.fromEntries(
        quarantineBunfigFiles(tracked).map((file) => [file, read(file)]),
      ),
      now,
    ),
    ...extensionProposalFailures({
      proposals: Object.fromEntries(
        tracked
          .filter(
            (file) =>
              file.startsWith(".github/dated-exception-proposals/") &&
              file.endsWith(".json"),
          )
          .map((file) => [file, read(file)]),
      ),
      entries,
      scope: expiryContext.scope,
      baseProposals: context.baseProposals,
      baseEntries: context.baseEntries,
      body: event?.pull_request ? (event.pull_request.body ?? "") : undefined,
    }),
  ];
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  }
}
