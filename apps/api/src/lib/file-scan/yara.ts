import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile, type RuleMatch } from "@litko/yara-x";
import type { Match, Scanner } from "pompelmi";

import { isRecord } from "@/api/lib/type-guards";

const YARA_DIR = join(import.meta.dir, "yara");

const compiled = compile(
  Array.from(new Bun.Glob("*.yar").scanSync(YARA_DIR))
    .map((f) => readFileSync(join(YARA_DIR, f), "utf8"))
    .join("\n"),
);

const YARA_SEVERITY_MAP: Record<string, Match["severity"]> = {
  malicious: "critical",
  suspicious: "suspicious",
};

export const yaraScanner: Scanner = {
  scan(bytes) {
    const matches = compiled.scan(Buffer.from(bytes));

    return matches.map((m: RuleMatch): Match => {
      const { meta } = m;
      const verdict =
        "verdict" in meta && typeof meta.verdict === "string"
          ? meta.verdict
          : undefined;

      return {
        rule: m.ruleIdentifier,
        severity: verdict ? YARA_SEVERITY_MAP[verdict] : "suspicious",
        meta: isRecord(meta) ? meta : {},
      };
    });
  },
};
