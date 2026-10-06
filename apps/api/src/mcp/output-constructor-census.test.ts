import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const API_SRC = path.resolve(import.meta.dir, "..");

// The tool-output surfaces: MCP tools and the chat adapter that runs them.
const TOOL_OUTPUT_DIRS = ["mcp", "handlers/chat"];

// The checked constructors themselves.
const CONSTRUCTOR_OWNER = "mcp/tool-utils.ts";

// An object literal building a tool success or a structured egress plan.
// Type positions (`{ egress: "structured" }`, `egress: "structured";`) do not
// match.
const RAW_OUTPUT_LITERAL = /(?:status: "success"|egress: "structured"),/u;

const sourceFiles = (dir: string): string[] =>
  readdirSync(path.join(API_SRC, dir), {
    recursive: true,
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts"),
    )
    .map((entry) =>
      path.relative(API_SRC, path.join(entry.parentPath, entry.name)),
    );

describe("tool output constructors", () => {
  test("every tool output is built through a checked constructor", () => {
    // `toolDataResult` and `structuredEgressPlan` reject a value carrying a
    // property its declared output lacks; a raw literal skips that check.
    const offenders = TOOL_OUTPUT_DIRS.flatMap(sourceFiles).filter(
      (file) =>
        file !== CONSTRUCTOR_OWNER &&
        RAW_OUTPUT_LITERAL.test(
          readFileSync(path.join(API_SRC, file), "utf-8"),
        ),
    );
    expect(offenders).toEqual([]);
  });

  test("the census reads the constructor owner", () => {
    expect(TOOL_OUTPUT_DIRS.flatMap(sourceFiles)).toContain(CONSTRUCTOR_OWNER);
    expect(
      RAW_OUTPUT_LITERAL.test(
        readFileSync(path.join(API_SRC, CONSTRUCTOR_OWNER), "utf-8"),
      ),
    ).toBe(true);
  });
});
