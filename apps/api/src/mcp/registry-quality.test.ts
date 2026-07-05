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

// Ceilings pinned to the measured counts after the tool-surface consolidation
// (plan 047): default 40 tools, anonymized 21 tools. 45 remains the hard
// product ceiling for the default surface; the five slots the consolidation
// recovered (40 -> 45) are deliberate headroom below that cap, and this ratchet
// sits at the tighter measured 40 so unreviewed growth fails first. Any tool
// added to either surface must bump the matching ceiling deliberately.
const TOOL_COUNT_CEILING: Record<SurfaceMode, number> = {
  default: 40,
  anonymized: 21,
};

// Serialized `tools/list` tool array (the wire payload produced by
// `toMcpTools`). Measured after plan 047: default 45_339 chars (~11.3k tokens),
// anonymized 19_472 chars (~4.9k tokens). Ceilings sit ~10-15% above so organic
// growth fits but a surface-size jump must be a deliberate constant bump.
const TOOLS_LIST_PAYLOAD_CHAR_CEILING: Record<SurfaceMode, number> = {
  default: 51_000,
  anonymized: 22_000,
};

// Longest description measured after plan 047: save_template at 724 chars
// (~180 tokens). Ceiling sits ~12% above.
const TOOL_DESCRIPTION_CHAR_CEILING = 810;

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

/**
 * `access` (plan 048 prerequisite: the chat code-mode projection selects
 * read-only tools structurally by this field) must stay coherent with the two
 * older, narrower signals that already implied a tool's mutation status:
 * MCP client-hint `annotations` and the anonymized-surface exclusion reason.
 * These are deterministic cross-checks over the static registry, not
 * per-tool assertions, so a new tool cannot silently declare `access` at odds
 * with either signal.
 */
// Widened to `McpToolDefinition` (which makes `annotations` a uniformly
// optional key) so the coherence checks below can destructure freely; the
// exported `as const satisfies` registry keeps each element's narrower
// literal type, which does not have `annotations` at all on tools that omit
// it and fails these checks' property access at the type level.
const defaultTools: readonly McpToolDefinition[] = DEFAULT_MCP_TOOL_DEFINITIONS;
const anonymizedTools: readonly McpToolDefinition[] =
  ANONYMIZED_MCP_TOOL_DEFINITIONS;

describe("MCP registry access coherence", () => {
  test('access: "write" tools never carry readOnlyHint', () => {
    for (const tool of defaultTools) {
      if (tool.access === "write") {
        expect(
          tool.annotations?.readOnlyHint,
          `Tool ${tool.name} is access: "write" but carries readOnlyHint`,
        ).not.toBe(true);
      }
    }
  });

  test('destructiveHint tools are always access: "write"', () => {
    for (const tool of defaultTools) {
      if (tool.annotations?.destructiveHint) {
        expect(
          tool.access,
          `Tool ${tool.name} carries destructiveHint but is not access: "write"`,
        ).toBe("write");
      }
    }
  });

  test('anonymized-exclusion reason "write" and access: "write" imply each other', () => {
    for (const tool of defaultTools) {
      const isWriteExcluded =
        tool.anonymized.exposure === "excluded" &&
        tool.anonymized.reason === "write";
      if (isWriteExcluded) {
        expect(
          tool.access,
          `Tool ${tool.name} is anonymized-excluded for "write" but is not access: "write"`,
        ).toBe("write");
      }
      if (tool.access === "write") {
        expect(
          isWriteExcluded,
          `Tool ${tool.name} is access: "write" but is not anonymized-excluded with reason "write"`,
        ).toBe(true);
      }
    }
  });

  test('access: "write" tools are absent from the anonymized surface', () => {
    const anonymizedNames = new Set(anonymizedTools.map((tool) => tool.name));
    for (const tool of defaultTools) {
      if (tool.access === "write") {
        expect(
          anonymizedNames.has(tool.name),
          `Tool ${tool.name} is access: "write" but appears on the anonymized surface`,
        ).toBe(false);
      }
    }
  });
});

const serializeToolSurface = (
  definitions: readonly McpToolDefinition[],
): string =>
  JSON.stringify(
    definitions.map(
      ({
        access,
        annotations,
        description,
        feature,
        inputSchema,
        name,
        scope,
      }) => ({
        name,
        scope,
        // Serialized so a change to a tool's read/write classification is a
        // visible snapshot diff, not a silent surface change.
        access,
        // Serialized so a change to a tool's deployment gate is a visible
        // snapshot diff, not a silent surface change.
        feature,
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
