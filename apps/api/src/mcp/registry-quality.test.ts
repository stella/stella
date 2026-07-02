import { describe, expect, test } from "bun:test";

import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import {
  ANONYMIZED_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_DEFINITIONS,
} from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";

/**
 * Deterministic registry-quality suite (plan 046, goal c). Everything here is
 * a pure function of the static tool definitions: no model in the loop, no
 * network, no tokenizer. Budgets are character counts; characters approximate
 * tokens at roughly 4:1, so e.g. a 21_000-char payload is ~5k tokens.
 *
 * The budgets are ratchets: each ceiling sits ~10-15% above the measured
 * value at the time of writing, so organic growth fits but a surface-size
 * jump (new tools, longer descriptions) fails the suite and must be a
 * deliberate, reviewed constant bump.
 */

const SURFACES = [
  { mode: "default", definitions: DEFAULT_MCP_TOOL_DEFINITIONS },
  { mode: "anonymized", definitions: ANONYMIZED_MCP_TOOL_DEFINITIONS },
] as const;

type SurfaceMode = (typeof SURFACES)[number]["mode"];

// Measured 2026-07-02: default 16 tools, anonymized 12 tools (plan 046 Wave 0
// projected the full read set onto the anonymized surface).
const TOOL_COUNT_CEILING: Record<SurfaceMode, number> = {
  default: 18,
  anonymized: 14,
};

// Serialized `tools/list` tool array (the wire payload produced by
// `toMcpTools`). Measured 2026-07-02: default 18_083 chars (~4.5k tokens),
// anonymized 7_147 chars (~1.8k tokens).
const TOOLS_LIST_PAYLOAD_CHAR_CEILING: Record<SurfaceMode, number> = {
  default: 20_500,
  anonymized: 8200,
};

// Longest description measured 2026-07-02: create_template at 791 chars
// (~200 tokens).
const TOOL_DESCRIPTION_CHAR_CEILING = 900;

// verb_noun style: lowercase words joined by single underscores.
const TOOL_NAME_PATTERN = /^[a-z]+(?:_[a-z]+)*$/u;

describe.each([...SURFACES])(
  "MCP registry quality ($mode surface)",
  ({ mode, definitions }) => {
    test("tool surface snapshot (name, scope, description, annotations, inputSchema)", () => {
      // Any change to the advertised surface shows up as a reviewable
      // snapshot diff. Registry order is the advertised wire order, so
      // reorders are surface changes too.
      expect(serializeToolSurface(definitions)).toMatchSnapshot();
    });

    test("tool count stays under the ceiling", () => {
      expect(definitions.length).toBeLessThanOrEqual(TOOL_COUNT_CEILING[mode]);
    });

    test("serialized tools/list payload stays under the character budget", () => {
      const payloadChars = JSON.stringify(toMcpTools(definitions)).length;
      expect(payloadChars).toBeLessThanOrEqual(
        TOOLS_LIST_PAYLOAD_CHAR_CEILING[mode],
      );
    });

    test("every tool description fits the per-tool character budget", () => {
      for (const tool of definitions) {
        expect(
          tool.description.length,
          `Tool ${tool.name} description is ${tool.description.length} chars`,
        ).toBeLessThanOrEqual(TOOL_DESCRIPTION_CHAR_CEILING);
      }
    });

    test("tool names follow verb_noun naming", () => {
      for (const tool of definitions) {
        expect(tool.name).toMatch(TOOL_NAME_PATTERN);
      }
    });

    test("every tool description is non-empty and starts with a capital letter", () => {
      for (const tool of definitions) {
        expect(
          tool.description,
          `Tool ${tool.name} description must start with a capital letter`,
        ).toMatch(/^[A-Z]/u);
      }
    });

    test("every input schema property has a non-empty description", () => {
      const issues: string[] = [];
      for (const tool of definitions) {
        collectUndescribedProperties(tool.inputSchema, tool.name, issues);
      }
      expect(issues).toEqual([]);
    });

    test("list_* and search_* tools accept a cursor; limit implies cursor", () => {
      for (const tool of definitions) {
        const properties = getInputProperties(tool);
        const isPaged =
          tool.name.startsWith("list_") || tool.name.startsWith("search_");
        if (isPaged || "limit" in properties) {
          expect(
            Object.keys(properties),
            `Tool ${tool.name} must accept a cursor input`,
          ).toContain("cursor");
        }
      }
    });
  },
);

const serializeToolSurface = (
  definitions: readonly McpToolDefinition[],
): string =>
  JSON.stringify(
    definitions.map(
      ({ annotations, description, inputSchema, name, scope }) => ({
        name,
        scope,
        description,
        annotations,
        inputSchema,
      }),
    ),
    null,
    2,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Walks a JSON Schema and records the path of every named property (at any
 * nesting depth, including array `items`) whose `description` is missing or
 * blank. Collecting paths instead of asserting inline makes a failure name
 * every offending property at once.
 */
const collectUndescribedProperties = (
  schema: unknown,
  path: string,
  issues: string[],
): void => {
  if (!isRecord(schema)) {
    return;
  }
  if (isRecord(schema["properties"])) {
    for (const [key, property] of Object.entries(schema["properties"])) {
      const propertyPath = `${path}.${key}`;
      if (
        !isRecord(property) ||
        typeof property["description"] !== "string" ||
        property["description"].trim() === ""
      ) {
        issues.push(propertyPath);
      }
      collectUndescribedProperties(property, propertyPath, issues);
    }
  }
  collectUndescribedProperties(schema["items"], `${path}[]`, issues);
};

const getInputProperties = (tool: McpToolDefinition): Record<string, unknown> =>
  isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
