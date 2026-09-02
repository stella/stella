import { describe, expect, test } from "bun:test";

import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import {
  ANONYMIZED_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_SETS,
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
// (plan 047): default 40 tools, anonymized 21 tools. The consolidation
// recovered five slots (40 -> 45); this ratchet makes every subsequent surface
// increase an explicit, reviewed decision rather than allowing silent growth.
// sits at the tighter measured 40 so unreviewed growth fails first. Any tool
// added to either surface must bump the matching ceiling deliberately.
// default bumped 40 -> 41 for the write-only `send_feedback` tool (agent-filed
// bug/feature/docs reports). It is excluded from the anonymized surface (a
// write tool), so the anonymized ceiling is unchanged.
// default bumped 41 -> 44 for the three capability meta-tools (plan 049 phase 2:
// list_capabilities, describe_capability, invoke_capability). All three are
// excluded from the anonymized surface (two read-only meta-reads that expose a
// dynamic tenant payload, one write), so the anonymized ceiling is unchanged.
// default bumped 44 -> 45 for internal contact-directory discovery; the tool
// reuses the HTTP capability's query and remains excluded from anonymized mode.
// default bumped 45 -> 46 for save_filled_template: the one compound
// server-side persistence tool that removes raw PUT/base64 transport from agent
// workflows while keeping fill_template least-privileged. Further additions
// should recover a slot through consolidation before expanding this ceiling.
// default bumped 46 -> 47 for upload_document_version, the canonical
// host-file/MCP-App entry point backed by the existing version-upload pipeline.
// default bumped 47 -> 48 to split the host-file data tool from its portable
// picker launcher; UI metadata is static, so a combined tool rendered the
// picker even after a host-provided file had already uploaded successfully.
const TOOL_COUNT_CEILING: Record<SurfaceMode, number> = {
  default: 48,
  anonymized: 21,
};

// Serialized `tools/list` tool array (the wire payload produced by
// `toMcpTools`). Measured after plan 047: default 45_339 chars (~11.3k tokens),
// anonymized 19_472 chars (~4.9k tokens). Ceilings sit ~10-15% above so organic
// growth fits but a surface-size jump must be a deliberate constant bump.
// default bumped 51_000 -> 54_000 for the three capability meta-tools (plan 049
// phase 2): measured 51_580 chars. The anonymized surface is unchanged (all
// three are excluded from it).
// default bumped 54_000 -> 61_000 after contact discovery and template
// persistence brought the measured payload to 55_283 chars.
// default bumped 61_000 -> 70_000 after save_template began advertising the
// canonical strict field-configuration contract instead of a loose object
// approximation: measured 63_213 chars. The new ceiling retains roughly 10%
// review headroom without weakening the provider-visible schema.
const TOOLS_LIST_PAYLOAD_CHAR_CEILING: Record<SurfaceMode, number> = {
  default: 70_000,
  anonymized: 22_000,
};

// Longest description measured after plan 047: save_template at 724 chars
// (~180 tokens). Ceiling sits ~12% above.
const TOOL_DESCRIPTION_CHAR_CEILING = 810;

// verb_noun style: lowercase words joined by single underscores.
const TOOL_NAME_PATTERN = /^[a-z]+(?:_[a-z]+)*$/u;

// Display titles: start with an uppercase letter, end without a period or
// whitespace, and contain at least one lowercase letter (sentence case, not
// shouting; the lowercase check lives in the test since a regex cannot say
// "not fully uppercase" readably). Internal punctuation is allowed. The
// 40-char product cap sits under the CLI trust boundary's 64-unit wire cap
// (MAX_TOOL_TITLE_CHARS in packages/cli/src/registry-trust.ts), so every
// title the registry can emit is also one a fetched listing would accept.
const TOOL_TITLE_MAX_CHARS = 40;
const TOOL_TITLE_PATTERN = /^[A-Z].*[^.\s]$/u;

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

    test("tool titles are unique, sentence-case display names", () => {
      const seen = new Map<string, string>();
      for (const tool of definitions) {
        const title = tool.annotations.title;
        expect(title, `Tool ${tool.name} title "${title}"`).toMatch(
          TOOL_TITLE_PATTERN,
        );
        expect(
          title,
          `Tool ${tool.name} title "${title}" is fully uppercase`,
        ).not.toBe(title.toUpperCase());
        expect(
          title.length,
          `Tool ${tool.name} title is ${title.length} chars`,
        ).toBeLessThanOrEqual(TOOL_TITLE_MAX_CHARS);
        const holder = seen.get(title);
        expect(
          holder,
          `Tools ${holder} and ${tool.name} share the title "${title}"`,
        ).toBeUndefined();
        seen.set(title, tool.name);
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
          tool.annotations.readOnlyHint,
          `Tool ${tool.name} is access: "write" but carries readOnlyHint`,
        ).not.toBe(true);
      }
    }
  });

  test('every access: "read" tool carries readOnlyHint', () => {
    // The converse of the check above, and the reason it matters: a client that
    // auto-approves read-only tools prompts for a read tool that omits the hint.
    for (const tool of defaultTools) {
      if (tool.access === "read") {
        expect(
          tool.annotations.readOnlyHint,
          `Tool ${tool.name} is access: "read" but omits readOnlyHint`,
        ).toBe(true);
      }
    }
  });

  test('destructiveHint tools are always access: "write"', () => {
    for (const tool of defaultTools) {
      if (tool.annotations.destructiveHint) {
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

/**
 * The two behavioural MCP annotations (`openWorldHint`, `idempotentHint`) must
 * be declared coherently with each tool's `access` classification, so an agent
 * client reasoning off the hints can never be misled by a missing or
 * contradictory declaration. Like the access-coherence block above, these are
 * deterministic cross-checks over the static registry: a new tool that omits
 * `openWorldHint`, forgets `idempotentHint` on a write, declares it on a read,
 * or ships a `delete_*` that is not idempotent fails the build.
 */
describe("MCP registry annotation coherence", () => {
  test("every tool declares openWorldHint explicitly (boolean)", () => {
    for (const tool of defaultTools) {
      expect(
        typeof tool.annotations.openWorldHint,
        `Tool ${tool.name} must declare annotations.openWorldHint explicitly`,
      ).toBe("boolean");
    }
  });

  test('every access: "write" tool declares idempotentHint explicitly (boolean)', () => {
    for (const tool of defaultTools) {
      if (tool.access !== "write") {
        continue;
      }
      expect(
        typeof tool.annotations.idempotentHint,
        `Tool ${tool.name} is access: "write" but does not declare annotations.idempotentHint`,
      ).toBe("boolean");
    }
  });

  test('read-only (access: "read") tools do not declare idempotentHint', () => {
    for (const tool of defaultTools) {
      if (tool.access !== "read") {
        continue;
      }
      expect(
        tool.annotations.idempotentHint,
        `Tool ${tool.name} is access: "read"; idempotentHint is meaningless and must be omitted`,
      ).toBeUndefined();
    }
  });

  test("every delete_* tool is idempotentHint true", () => {
    for (const tool of defaultTools) {
      if (!tool.name.startsWith("delete_")) {
        continue;
      }
      expect(
        tool.annotations.idempotentHint,
        `Tool ${tool.name} is a delete_* tool and must be idempotentHint true`,
      ).toBe(true);
    }
  });

  test("the anonymized projection carries annotations through unchanged", () => {
    const defaultByName = new Map(
      defaultTools.map((tool) => [tool.name, tool]),
    );
    for (const tool of anonymizedTools) {
      const source = defaultByName.get(tool.name);
      expect(
        source,
        `Anonymized tool ${tool.name} has no default-surface counterpart`,
      ).toBeDefined();
      if (!source) {
        continue;
      }
      expect(
        tool.annotations,
        `Anonymized tool ${tool.name} annotations diverge from the default surface`,
      ).toEqual(source.annotations);
    }
  });
});

/**
 * Advertised input property names. The anonymized surface is a projection of
 * the same definitions, so checking the default surface covers both.
 *
 * The nested paths below are the remaining camelCase debt: object and array
 * payloads that mirror internal document/field models (`knowledge-tools.ts`,
 * `stella-tools.ts`, `template-tools.ts`). The set is exact, so a new
 * camelCase name fails here and fixing one of these requires shrinking the
 * constant. Every TOP-LEVEL name (the surface an agent types) must already be
 * snake_case: none is listed, so any drift there fails immediately.
 */
const CAMEL_CASE_INPUT_PROPERTY_DEBT = [
  "save_clause.body[].directiveExpression",
  "save_clause.body[].directiveKind",
  "save_clause.body[].isDirective",
  "save_clause.body[].listKind",
  "save_clause.body[].listLevel",
  "save_template.fields[].aiAdapt",
  "save_template.fields[].aiPrompt",
  "save_template.fields[].aiSeesDocument",
  "save_template.fields[].dateFormat",
  "save_template.fields[].inputType",
  "save_template.fields[].optionsFrom",
  "save_template.fields[].parts[].inputType",
  "save_template.fields[].validation.maxItems",
  "save_template.fields[].validation.maxLength",
  "save_template.fields[].validation.minItems",
  "save_template.fields[].validation.minLength",
  "set_practice_jurisdictions.jurisdictions[].countryCode",
  "set_practice_jurisdictions.jurisdictions[].isPrimary",
];

describe("MCP registry input naming", () => {
  test("input property names are snake_case, bar the recorded debt", () => {
    const issues: string[] = [];
    for (const tool of defaultTools) {
      collectNonSnakeCaseProperties(tool.inputSchema, tool.name, issues);
    }
    expect(issues.sort()).toEqual(CAMEL_CASE_INPUT_PROPERTY_DEBT);
  });
});

describe("MCP static tool-set coherence", () => {
  test("each static tool set binds exactly one handler per advertised definition", () => {
    for (const toolSet of DEFAULT_MCP_TOOL_SETS) {
      const definitionNames = toolSet.definitions.map((tool) => tool.name);
      const handlerNames = Object.keys(toolSet.handlers);

      expect(handlerNames.sort()).toEqual(definitionNames.sort());
    }
  });

  test("static tool names are unique across tool sets", () => {
    const names = DEFAULT_MCP_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

const serializeToolSurface = (
  definitions: readonly McpToolDefinition[],
): string =>
  JSON.stringify(
    definitions.map(
      ({
        access,
        additionalScopes,
        annotations,
        description,
        feature,
        inputSchema,
        name,
        scope,
      }) => ({
        name,
        scope,
        additionalScopes,
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

// Advertised input property names: lowercase words joined by single
// underscores. The name is the one part of a tool contract an agent has to
// reproduce exactly, so a camelCase outlier (or a synonym like `workspace_id`
// beside ten `matter_id`s) is a correctness cost, not a style preference.
const SNAKE_CASE_PROPERTY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

/** Walks a JSON Schema and records the path of every non-snake_case property. */
const collectNonSnakeCaseProperties = (
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
      if (!SNAKE_CASE_PROPERTY.test(key)) {
        issues.push(propertyPath);
      }
      collectNonSnakeCaseProperties(property, propertyPath, issues);
    }
  }
  collectNonSnakeCaseProperties(schema["items"], `${path}[]`, issues);
};

const getInputProperties = (
  tool: McpToolDefinition,
): Record<string, unknown> =>
  isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};

/**
 * Guards the `delete_` naming convention the chat frontend relies on to
 * restrict destructive-write approvals to allow-once/deny only (no "allow in
 * conversation", no "always allow"). The frontend has no access to the MCP
 * `annotations.destructiveHint`; it keys purely off the `delete_` name prefix
 * (`isDestructiveChatToolName`). This test keeps that heuristic honest: it must
 * agree with the registry's own destructive classification in both directions,
 * so a destructive tool named without the prefix, or a `delete_` tool missing
 * the hint, fails the build rather than silently letting a delete be
 * auto-approved (or a save be treated as irreversible).
 */
describe("destructive write-tool naming convention", () => {
  const writeTools: readonly McpToolDefinition[] =
    DEFAULT_MCP_TOOL_DEFINITIONS.filter((tool) => tool.access === "write");

  test("every destructiveHint write tool is named delete_*", () => {
    const offenders = writeTools
      .filter((tool) => tool.annotations.destructiveHint === true)
      .filter((tool) => !tool.name.startsWith("delete_"))
      .map((tool) => tool.name);
    expect(offenders).toEqual([]);
  });

  test("every delete_* write tool carries destructiveHint", () => {
    const offenders = writeTools
      .filter((tool) => tool.name.startsWith("delete_"))
      .filter((tool) => tool.annotations.destructiveHint !== true)
      .map((tool) => tool.name);
    expect(offenders).toEqual([]);
  });
});
