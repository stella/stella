import { describe, expect, test } from "bun:test";

const ADAPTER_BOUNDARY_FILES = [
  "src/core/prosemirror/conversion/fromProseDoc.ts",
  "src/core/layout-bridge/toFlowBlocks.ts",
  "src/core/prosemirror/validation.ts",
] as const;

const FORBIDDEN_RAW_ATTR_PATTERNS = [
  {
    pattern:
      /\b(?:node|child|rowNode|cellNode|contentNode|sdtChild)\.attrs\s+as\b/u,
    reason: "Raw node attrs must be narrowed through the typed attr readers.",
  },
  {
    pattern: /\b(?:node|child|rowNode|cellNode|contentNode|sdtChild)\.attrs\[/u,
    reason: "Bracket attr reads bypass path-aware validation diagnostics.",
  },
  {
    pattern:
      /\bconst\s+attrs\s*=\s*(?:node|child|rowNode|cellNode|contentNode|sdtChild)\.attrs\b/u,
    reason: "Do not alias raw attrs at conversion/layout boundaries.",
  },
] as const;

describe("ProseMirror adapter attr boundaries", () => {
  test("keep conversion and layout attr reads behind typed readers", async () => {
    const violations: string[] = [];

    for (const file of ADAPTER_BOUNDARY_FILES) {
      const source = await Bun.file(file).text();
      const lines = source.split("\n");

      for (const [index, line] of lines.entries()) {
        for (const { pattern, reason } of FORBIDDEN_RAW_ATTR_PATTERNS) {
          if (!pattern.test(line)) {
            continue;
          }
          violations.push(`${file}:${index + 1}: ${reason}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
