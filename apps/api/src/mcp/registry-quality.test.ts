import { describe, expect, test } from "bun:test";

import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { MCP_CASING_RULE, MCP_INSTRUCTIONS } from "@/api/mcp/instructions";
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
// default bumped 48 -> 49 for delete_task: tasks were the one workspace entity
// deletable over HTTP but not through MCP (delete_document refuses them by
// kind), so agents and the CLI had no way to remove one. Write-only, so the
// anonymized ceiling is unchanged.
const TOOL_COUNT_CEILING: Record<SurfaceMode, number> = {
  default: 49,
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
// anonymized bumped 22_000 -> 23_403, exactly the measured growth from deriving
// every advertised schema from its runtime validator: +609 chars of
// `additionalProperties`, +682 of `minLength`/`format` bounds the handlers
// already enforced, +112 of explicit empty `required` lists. Stripping those
// three keyword classes reproduces the previous payload byte for byte, so no
// description, enum or property grew; the default surface still fits its
// ceiling unchanged.
// anonymized bumped 23_403 -> 23_557 when the scoping input was renamed and an
// alias clause was added per field; the alias is gone, so the payload sits
// below that again and the ceiling keeps the headroom.
// default bumped 70_000 -> 70_100 for delete_task plus the uuid format on
// entity ids and the task status/priority enums: measured 70_059 chars.
// default bumped 70_100 -> 70_200 when save_template gained the host file
// reference (the same four-property object upload_document_version
// advertises): measured 70_171 chars, and the tool description shrank to pay
// part of it back.
const TOOLS_LIST_PAYLOAD_CHAR_CEILING: Record<SurfaceMode, number> = {
  default: 70_200,
  anonymized: 23_557,
};

// Longest description measured after plan 047: save_template at 724 chars
// (~180 tokens), 807 after it documented the file transport. Ceiling keeps a
// little headroom above that.
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

    test("every advertised object schema states its unknown-key policy", () => {
      const issues: string[] = [];
      for (const tool of definitions) {
        collectOpenObjectSchemas(tool.inputSchema, tool.name, issues);
      }
      expect(
        issues,
        `These advertised object schemas leave additionalProperties undeclared, so a client cannot tell whether a typo errors or is ignored: ${issues.join(", ")}. Derive the schema from the v.strictObject its handler parses (defineValibotMcpTool) for additionalProperties: false, or declare additionalProperties: true explicitly for a map whose keys are caller data.`,
      ).toEqual([]);
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
 * The set is exact and empty: every advertised name, at every depth, must be
 * snake_case. Payloads that mirror internal camelCase models (`save_clause`
 * body paragraphs, `save_template` field overlays) carry their own snake_case
 * input schema and map onto the model at the tool boundary, so a new
 * camelCase name anywhere in an input fails here.
 */
const CAMEL_CASE_INPUT_PROPERTY_DEBT: string[] = [];

describe("MCP registry input naming", () => {
  test("input property names are snake_case at every depth", () => {
    const issues: string[] = [];
    for (const tool of defaultTools) {
      collectNonSnakeCaseProperties(tool.inputSchema, tool.name, issues);
    }
    expect([...new Set(issues)].sort()).toEqual(CAMEL_CASE_INPUT_PROPERTY_DEBT);
  });

  // The other half of the same convention: inputs are snake_case, payloads are
  // camelCase. Property names are enforced structurally above; the payload half
  // cannot be, so every surface states the rule at connect time instead.
  test("every surface states the casing rule at connect time", () => {
    for (const [mode, instructions] of Object.entries(MCP_INSTRUCTIONS)) {
      expect(
        instructions,
        `The ${mode} instructions must state the snake_case-in/camelCase-out rule`,
      ).toContain(MCP_CASING_RULE);
    }
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

/**
 * Walks a JSON Schema and records the path of every object schema that leaves
 * unknown keys UNDECLARED. A client must be able to predict, from the
 * advertised schema alone, whether a typo is rejected or swallowed; silence is
 * the one answer it cannot act on. Three declarations are honest:
 * `additionalProperties: false` (the default for a curated tool),
 * `additionalProperties: { ... }` (a constrained map: every key validated), and
 * an explicit `additionalProperties: true` for an open map whose keys are
 * caller data, such as a template's field-path -> value map.
 */
const collectOpenObjectSchemas = (
  schema: unknown,
  path: string,
  issues: string[],
): void => {
  if (!isRecord(schema)) {
    return;
  }
  const isObjectSchema =
    schema["type"] === "object" || isRecord(schema["properties"]);
  const additionalProperties = schema["additionalProperties"];
  const declaresUnknownKeyPolicy =
    additionalProperties === false ||
    additionalProperties === true ||
    isRecord(additionalProperties);
  if (isObjectSchema && !declaresUnknownKeyPolicy) {
    issues.push(path);
  }
  if (isRecord(schema["properties"])) {
    for (const [key, property] of Object.entries(schema["properties"])) {
      collectOpenObjectSchemas(property, `${path}.${key}`, issues);
    }
  }
  if (isRecord(schema["patternProperties"])) {
    for (const property of Object.values(schema["patternProperties"])) {
      collectOpenObjectSchemas(property, `${path}[*]`, issues);
    }
  }
  collectOpenObjectSchemas(
    schema["additionalProperties"],
    `${path}[*]`,
    issues,
  );
  collectOpenObjectSchemas(schema["items"], `${path}[]`, issues);
  for (const keyword of ["anyOf", "allOf", "oneOf"]) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      for (const [index, branch] of branches.entries()) {
        collectOpenObjectSchemas(
          branch,
          `${path}<${keyword}[${index}]>`,
          issues,
        );
      }
    }
  }
};

// Advertised input property names: lowercase words joined by single
// underscores. The name is the one part of a tool contract an agent has to
// reproduce exactly, so a camelCase outlier (or a synonym for a name the rest
// of the surface already settled) is a correctness cost, not a style
// preference. `input-vocabulary.test.ts` guards the scoping name specifically.
const SNAKE_CASE_PROPERTY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

/**
 * Walks every schema-bearing branch the CLI trust boundary admits
 * (`registry-trust.ts`) and records the path of each non-snake_case property.
 * Union branches share their parent's path, so one offending name is one
 * entry however many branches carry it.
 */
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
  if (isRecord(schema["patternProperties"])) {
    for (const property of Object.values(schema["patternProperties"])) {
      collectNonSnakeCaseProperties(property, `${path}[*]`, issues);
    }
  }
  collectNonSnakeCaseProperties(
    schema["additionalProperties"],
    `${path}[*]`,
    issues,
  );
  collectNonSnakeCaseProperties(schema["items"], `${path}[]`, issues);
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) {
      continue;
    }
    for (const branch of branches) {
      collectNonSnakeCaseProperties(branch, path, issues);
    }
  }
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
