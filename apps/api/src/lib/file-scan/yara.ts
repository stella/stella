import { compile } from "@litko/yara-x";
import type { RuleMatch } from "@litko/yara-x";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Match, Scanner } from "@/api/lib/file-scan/scanner";
import { isRecord } from "@/api/lib/type-guards";

const YARA_DIR = join(import.meta.dir, "yara");

const compiled = compile(
  [...new Bun.Glob("*.yar").scanSync(YARA_DIR)]
    .map((f) => readFileSync(join(YARA_DIR, f), "utf-8"))
    .join("\n"),
);

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
