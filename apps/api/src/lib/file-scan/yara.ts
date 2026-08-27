import { compile } from "@litko/yara-x";
import type { RuleMatch } from "@litko/yara-x";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Match, Scanner } from "@/api/lib/file-scan/scanner";
import { isRecord } from "@/api/lib/type-guards";

const YARA_DIR = path.join(import.meta.dir, "yara");

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

export const yaraScanner: Scanner = {
  async scan(bytes) {
    const matches = compiled.scan(Buffer.from(bytes));

    return await Promise.resolve(
      matches.map((m: RuleMatch): Match => {
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
      }),
    );
  },
};
