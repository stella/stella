import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const readMcpSource = (relativePath: string): string =>
  readFileSync(`${import.meta.dir}/${relativePath}`, "utf-8");

describe("agent input normalization architecture", () => {
  test("every first-party agent dispatch surface calls the shared boundary", () => {
    const boundaryCalls = {
      "tools.ts": "normalizeObjectInputAtBoundary({",
      "capability-tools.ts": "normalizeInputAtBoundary({",
      "../handlers/chat/tools/registry-adapter/run-registry-tool.ts":
        "normalizeObjectInputAtBoundary({",
      "../handlers/chat/tools/registry-adapter/run-registry-write-tool.ts":
        "normalizeObjectInputAtBoundary({",
    } as const;

    for (const [file, call] of Object.entries(boundaryCalls)) {
      expect(readMcpSource(file), `${file} bypasses shared normalization`).toContain(
        call,
      );
    }
  });

  test("static MCP handlers do not parse agent scalar spellings ad hoc", () => {
    const parserPattern =
      /normalize(?:Boolean|DateValue|EnumValue|Locale|Number)|Number\.parse(?:Int|Float)|Date\.parse|new Date\(/u;
    const violations: string[] = [];
    const files = readdirSync(import.meta.dir).filter((file) =>
      file.endsWith("-tools.ts"),
    );

    for (const file of files) {
      const lines = readMcpSource(file).split("\n");
      for (const [index, line] of lines.entries()) {
        if (
          parserPattern.test(line) &&
          !lines
            .slice(Math.max(0, index - 3), index + 1)
            .some((candidate) =>
              candidate.includes("agent-input-normalization-ignore:"),
            )
        ) {
          violations.push(`${file}:${index + 1}`);
        }
      }
    }

    expect(
      violations,
      "Declare the field's normalization kind in its canonical schema and let the shared dispatch boundary normalize it. Opaque protocol values need a nearby agent-input-normalization-ignore: reason.",
    ).toEqual([]);
  });
});
