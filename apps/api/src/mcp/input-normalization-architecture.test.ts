import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { AGENT_INPUT_NORMALIZATION_KEY } from "@stll/agent-input";

import { isRecord } from "@/api/lib/type-guards";
import { ALL_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

const readMcpSource = (relativePath: string): string =>
  readFileSync(`${import.meta.dir}/${relativePath}`, "utf-8");

/** Every advertised top-level property of every registered tool. */
const advertisedProperties = ALL_MCP_TOOL_DEFINITIONS.flatMap((definition) => {
  const properties = definition.inputSchema.properties;
  return isRecord(properties)
    ? Object.entries(properties).flatMap(([name, schema]) =>
        isRecord(schema) ? [{ tool: definition.name, name, schema }] : [],
      )
    : [];
});

describe("agent input normalization architecture", () => {
  test("a property's conventional name carries its kind on every tool", () => {
    // `limit` clamps and `date_from`/`date_to` read as range bounds because
    // the factory binds them by name; a tool that projected its own schema
    // around the factory would lose that silently.
    const unbound = advertisedProperties.flatMap(({ tool, name, schema }) => {
      const annotation = schema[AGENT_INPUT_NORMALIZATION_KEY];
      const kind = isRecord(annotation) ? annotation : {};
      if (name === "limit" && typeof schema["maximum"] === "number") {
        return kind["range"] === "clamp" ? [] : [`${tool}.${name}`];
      }
      if (
        (name === "date_from" || name === "date_to") &&
        schema["format"] === "date"
      ) {
        return kind["bound"] === (name === "date_from" ? "start" : "end")
          ? []
          : [`${tool}.${name}`];
      }
      return [];
    });
    expect(unbound).toEqual([]);
  });

  test("an unreadable cursor is refused by the one owner", () => {
    // `invalidCursorResult` names the restart; a hand-built refusal drifts
    // back to a hint that leaves the caller guessing whether to retry.
    const violations = readdirSync(import.meta.dir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => file !== "tool-utils.ts")
      .filter((file) =>
        /message:\s*"(?:Invalid|Malformed) cursor"/u.test(readMcpSource(file)),
      );
    expect(violations).toEqual([]);
  });

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
      expect(
        readMcpSource(file),
        `${file} bypasses shared normalization`,
      ).toContain(call);
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
