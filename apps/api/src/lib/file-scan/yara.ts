import { compile } from "@litko/yara-x";
import type { RuleMatch } from "@litko/yara-x";
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Match, Scanner } from "@/api/lib/file-scan/scanner";
import { runtimeYaraRulesDir } from "@/api/lib/runtime-worker-path";
import { isRecord } from "@/api/lib/type-guards";

// Compiled Bun binaries cannot enumerate external directories under /$bunfs.
const YARA_DIR = runtimeYaraRulesDir() || path.join(import.meta.dir, "yara");

const ruleFiles = [...new Bun.Glob("*.yar").scanSync(YARA_DIR)];

// An empty rule directory compiles into a scanner that matches nothing, so a
// missing rules deployment would pass silently. Exported for the image smoke
// probe (scripts/image-smoke.ts), which asserts the count is non-zero.
export const yaraRuleFileCount = ruleFiles.length;

const ruleSource = ruleFiles
  .map((f) => readFileSync(path.join(YARA_DIR, f), "utf-8"))
  .join("\n");

const compiled = compile(ruleSource);

// Derived from the rule files rather than listed by hand, so the coverage
// contract test (yara-coverage.test.ts) sees a rule the moment it is added.
export const yaraRuleNames: readonly string[] = [
  ...ruleSource.matchAll(/^rule\s+(\w+)/gmu),
].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));

const YARA_SEVERITY_MAP: Record<string, Match["severity"]> = {
  malicious: "critical",
  suspicious: "suspicious",
};

const toMatch = (m: RuleMatch): Match => {
  const { meta } = m;
  const verdict =
    "verdict" in meta && typeof meta.verdict === "string"
      ? meta.verdict
      : undefined;

  const severity =
    (verdict ? YARA_SEVERITY_MAP[verdict] : undefined) ?? "suspicious";
  const match: Match = {
    rule: m.ruleIdentifier,
    severity,
  };
  if (isRecord(meta)) {
    match.meta = meta;
  }
  return match;
};

export const yaraScanner: Scanner = {
  async scan(bytes) {
    return await Promise.resolve(
      compiled.scan(Buffer.from(bytes)).map(toMatch),
    );
  },
};

/** One occurrence of one rule pattern within a scanned window. */
export type PatternOccurrence = {
  rule: string;
  pattern: string;
  offset: number;
  length: number;
};

/**
 * The rule set split for content that is too large to scan in one buffer.
 * `occurrences` finds every pattern of every rule in a window regardless of
 * the rule's condition; `evaluate` then runs one rule's real condition over
 * the occurrences collected for it.
 */
export type WindowedRuleSet = {
  /** Longest match the engine reports; a longer one is never found at all. */
  maxMatchBytes: number;
  /** Rules whose condition counts occurrences, so every one must be kept. */
  countingRules: ReadonlySet<string>;
  occurrences: (window: Uint8Array) => PatternOccurrence[];
  evaluate: (rule: string, evidence: Uint8Array) => Match | null;
};

// YARA-X stops extending a match at 4096 bytes: a longer occurrence of an
// unbounded or wide pattern is not reported even in a single-buffer scan.
// archive.test.ts pins this against the engine.
export const YARA_MAX_MATCH_BYTES = 4096;

const CONDITION_KEYWORD = "condition:";

// A rule opens with `rule <name>` and closes with `}`, both at the start of a
// line, which is how every rule file here is written.
const ruleBlocks = ruleSource.split(/^(?=rule\s)/mu).flatMap((chunk) => {
  const name = /^rule\s+(\w+)/u.exec(chunk)?.[1];
  if (name === undefined) {
    return [];
  }
  const conditionAt = chunk.indexOf(CONDITION_KEYWORD);
  const closeAt = chunk.indexOf("\n}", conditionAt);
  if (conditionAt === -1 || closeAt === -1) {
    return panic(`YARA rule ${name} has no condition block`);
  }
  return [
    {
      name,
      strings: chunk.slice(0, conditionAt),
      condition: chunk.slice(conditionAt + CONDITION_KEYWORD.length, closeAt),
    },
  ];
});

// Every rule keeps its strings and reports each occurrence of any of them.
const occurrenceRules = compile(
  ruleBlocks
    .map(({ strings }) => `${strings}${CONDITION_KEYWORD} any of them\n}`)
    .join("\n"),
);

export const yaraWindowedRules: WindowedRuleSet = {
  maxMatchBytes: YARA_MAX_MATCH_BYTES,
  countingRules: new Set(
    ruleBlocks.flatMap(({ name, condition }) =>
      condition.includes("#") ? [name] : [],
    ),
  ),
  occurrences: (window) =>
    occurrenceRules.scan(Buffer.from(window)).flatMap((m) =>
      m.matches.map(({ identifier, offset, length }) => ({
        rule: m.ruleIdentifier,
        pattern: identifier,
        offset,
        length,
      })),
    ),
  evaluate: (rule, evidence) => {
    const match = compiled
      .scan(Buffer.from(evidence))
      .find((m) => m.ruleIdentifier === rule);
    return match === undefined ? null : toMatch(match);
  },
};

/** Rule names the windowed split was derived from, for its contract test. */
export const yaraWindowedRuleNames: readonly string[] = ruleBlocks.map(
  ({ name }) => name,
);
