// Add each new dated exception at its owner, then register its adapter here.
// The census covers policy/config expiry keys; prose-only review promises need
// an explicit adapter (see docs/maintenance/dated-waivers.md).
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

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
import { readBaseline } from "./dependency-audit";
import type { AcceptanceTerms } from "./dependency-audit-acceptance";
import { parseLedger } from "./suppression-waivers";

export const DAY_MS = 86_400_000;
export const WARNING_DAYS = 5;
export const RECHECK_DAYS = 14;
export const DOC_SOURCE_FILE = ".claude/mcp/doc-sources.ts";

export const RECHECK_INSTRUCTIONS = {
  "no-llms-txt":
    "Recheck canonical documentation for llms.txt; register a source if available, otherwise record evidence and a new review window.",
  "release-age-exclusion":
    "Verify the pinned release passes the normal release-age gate, then remove the temporary exclusion.",
  "release-age-exception":
    "Recheck the release-age policy and remove or justify the annotated exception.",
  "dependency-audit":
    "Re-run the dependency audit, check patched releases and dependency reachability; remove or re-justify the acceptance.",
  "suppression-waiver":
    "Recheck the suppression invariant and evidence; remove the suppression or obtain a reviewed justification.",
} as const;

export type DatedWaiver = {
  source: string;
  line: number;
  id: string;
  kind: keyof typeof RECHECK_INSTRUCTIONS;
  // Preserve the owner-written deadline; normalize only for evaluation.
  expiresAt: string;
  checkedAt?: string;
};

// Date-only owners accept through the entire UTC day. Preserve that boundary.
const expiryInstant = (date: string): string => {
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
};

export const collectWaivers = ({
  read,
  docs,
  audit,
  bunfigs,
  releaseAgeSources,
}: CollectWaiversOptions): DatedWaiver[] => {
  const entries: DatedWaiver[] = docs.map((entry) => ({
    source: DOC_SOURCE_FILE,
    line: sourceLine(read(DOC_SOURCE_FILE), entry.dependency),
    id: entry.dependency,
    kind: "no-llms-txt",
    expiresAt: entry.expiresAt,
    checkedAt: entry.checkedAt,
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
      expiresAt: entry.expires,
    });
  }
  const exceptions = readReleaseAgeExceptions(releaseAgeSources);
  if (exceptions.errors.length > 0) {
    panic(exceptions.errors.join("\n"));
  }
  for (const entry of exceptions.entries) {
    entries.push({
      ...entry,
      id: `${entry.source}:${entry.line}`,
      kind: "release-age-exception",
    });
  }
  for (const entry of entries) {
    expiryInstant(entry.expiresAt);
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

export const trackedPolicyFiles = (): string[] => {
  const proc = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: path.resolve(import.meta.dir, ".."),
  });
  if (proc.exitCode !== 0) {
    panic("Cannot enumerate tracked policy files");
  }
  return proc.stdout.toString().split("\0").filter(Boolean);
};

export const loadWaivers = async (): Promise<DatedWaiver[]> => {
  const root = path.resolve(import.meta.dir, "..");
  const read = (file: string): string =>
    readFileSync(path.join(root, file), "utf-8");
  const tracked = trackedPolicyFiles();
  const files = tracked.filter(
    (file) => file === "bunfig.toml" || file.endsWith("/bunfig.toml"),
  );
  const configSources = Object.fromEntries(
    RELEASE_AGE_EXCEPTION_SOURCES.map((file) => [file, read(file)]),
  );
  return collectWaivers({
    read,
    docs: DOC_SOURCE_EXCLUSIONS,
    audit: (await readBaseline()).accepted,
    bunfigs: files,
    releaseAgeSources: configSources,
  });
};

if (import.meta.main) {
  const entries = await loadWaivers();
  if (process.argv.includes("--due")) {
    console.log(dueWaivers(entries, new Date()).length > 0);
  } else if (process.argv.includes("--warn")) {
    for (const warning of waiverWarnings(entries, new Date())) {
      console.log(warning);
    }
  } else {
    console.log(JSON.stringify(entries, null, 2));
  }
}
