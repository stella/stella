import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  MCP_TOOL_NAME_MAX_LENGTH,
  MCP_TOOL_NAME_PATTERN,
} from "@stll/api-contract/mcp-tool-name";
import type { PermissionInput } from "@stll/permissions";
import { propertyConfig } from "@stll/property-testing";

import { SKILL_SLUG_MAX_LENGTH } from "@/api/handlers/skills/slug";
import {
  collisionSafeToolName,
  DYNAMIC_TOOL_NAMESPACES,
  dynamicToolNamespaceOf,
  dynamicToolNamespacePrefix,
  EMITTED_TOOL_NAME_MAX_LENGTH,
  namespaceMcpToolName,
  namespaceSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import { MCP_MODES } from "@/api/mcp/constants";
import {
  DYNAMIC_TOOL_FAMILY_POLICIES,
  getDynamicMcpToolOutputContract,
} from "@/api/mcp/gateway/dynamic-tool-policy";
import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { MCP_CASING_RULE, MCP_INSTRUCTIONS } from "@/api/mcp/instructions";
import {
  ANONYMIZED_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_SETS,
  getStaticMcpToolOutputContract,
  listStaticMcpToolDefinitions,
} from "@/api/mcp/static-tool-definitions";
import type {
  McpToolDefinition,
  RuntimeMcpToolOutputContract,
} from "@/api/mcp/tool-types";
import {
  defineMcpToolOutput,
  deriveUncompactedMcpOutputSchema,
} from "@/api/mcp/valibot-tool-definition";
import { selectableOperations } from "@/api/mcp/write-tool-authority";
import {
  compileWireSchema,
  createWireSchemaValidator,
  schemaComparisonArbitrary,
} from "@/api/tests/helpers/wire-json-schema";

import {
  baselineAudiences,
  diffMcpSurfaceBaseline,
  formatSurfaceDrifts,
  measureMcpSurfaces,
  readMcpSurfaceBaseline,
} from "../../scripts/mcp-surface-baseline";

/**
 * Deterministic registry-quality suite (plan 046, goal c). Everything here is
 * a pure function of the static tool definitions: no model in the loop, no
 * network, no tokenizer.
 *
 * Surface sizes (tool count and every advertised part, per audience) are held
 * by the committed `apps/api/mcp-surface-baseline.json`, measured by
 * `scripts/mcp-surface-baseline.ts`: it stores one row per tool and audience,
 * the totals are derived from the rows, and a change that moves a total past
 * its tolerance rewrites that file, so the pull request argues for the diff.
 * The per-tool ceilings below are fixed limits, not measurements.
 */

// Every audience, read from the canonical registry. Each is serialized with
// its own mode wherever a wire tool is built: output contracts resolve per
// audience, so a default-mode serialization measures another audience's
// schemas.
const SURFACES = MCP_MODES.map((mode) => ({
  mode,
  definitions: listStaticMcpToolDefinitions(mode),
}));

// A single tool must not consume an unreviewed multi-thousand-token block of
// every tools/list. The largest measured schema is in the surface baseline.
const OUTPUT_SCHEMA_CHAR_CEILING = 4000;

// An editorial limit on one description; the largest measured one is in the
// surface baseline.
const TOOL_DESCRIPTION_CHAR_CEILING = 810;

// verb_noun style: lowercase words joined by single underscores.
const STATIC_TOOL_NAME_STYLE = /^[a-z]+(?:_[a-z]+)*$/u;

// Display titles: start with an uppercase letter, end without a period or
// whitespace, and contain at least one lowercase letter (sentence case, not
// shouting; the lowercase check lives in the test since a regex cannot say
// "not fully uppercase" readably). Internal punctuation is allowed. The
// 40-char product cap sits under the CLI trust boundary's 64-unit wire cap
// (MAX_TOOL_TITLE_CHARS in packages/cli/src/registry-trust.ts), so every
// title the registry can emit is also one a fetched listing would accept.
const TOOL_TITLE_MAX_CHARS = 40;
const WIRE_TOOL_TITLE_MAX_CHARS = 64;
const TOOL_TITLE_PATTERN = /^[A-Z].*[^.\s]$/u;

describe("MCP tool-surface baseline", () => {
  const baseline = readMcpSurfaceBaseline();

  test("every audience has exactly one baseline row", () => {
    expect(baselineAudiences(baseline)).toEqual([...MCP_MODES].toSorted());
  });

  test("every audience matches its committed baseline within tolerance", async () => {
    const current = await measureMcpSurfaces();
    const drifts = diffMcpSurfaceBaseline(current, baseline);
    expect(
      drifts.length === 0 ? "" : formatSurfaceDrifts(drifts, current),
    ).toBe("");
  });
});

describe.each(SURFACES)(
  "MCP registry quality ($mode surface)",
  ({ mode, definitions }) => {
    test("tool surface snapshot (name, scope, description, annotations, inputSchema)", () => {
      // Any change to the advertised surface shows up as a reviewable
      // snapshot diff. Registry order is the advertised wire order, so
      // reorders are surface changes too.
      expect(serializeToolSurface(definitions)).toMatchSnapshot();
    });

    test("every wire tool carries a display title and explicit safety hints", () => {
      for (const tool of toMcpTools(definitions, { mode })) {
        expect(
          tool.title,
          `Tool ${tool.name} must advertise a title`,
        ).toBeDefined();
        expect(
          tool.title?.trim().length,
          `Tool ${tool.name} title is empty`,
        ).toBeGreaterThan(0);
        expect(
          tool.title?.length,
          `Tool ${tool.name} title exceeds the wire limit`,
        ).toBeLessThanOrEqual(WIRE_TOOL_TITLE_MAX_CHARS);
        for (const hint of [
          "readOnlyHint",
          "destructiveHint",
          "openWorldHint",
        ] as const) {
          expect(
            typeof tool.annotations?.[hint],
            `Tool ${tool.name} must advertise annotations.${hint}`,
          ).toBe("boolean");
        }
      }
    });

    test("every output schema fits the per-tool budget", () => {
      for (const tool of toMcpTools(definitions, { mode })) {
        const chars = JSON.stringify(tool.outputSchema).length;
        expect(
          chars,
          `Tool ${tool.name} output schema is ${chars} chars`,
        ).toBeLessThanOrEqual(OUTPUT_SCHEMA_CHAR_CEILING);
      }
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
        expect(tool.name).toMatch(STATIC_TOOL_NAME_STYLE);
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
          holder === undefined
            ? undefined
            : `Tools ${holder} and ${tool.name} share the title "${title}"`,
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
  test('every access: "write" tool carries readOnlyHint false', () => {
    for (const tool of defaultTools) {
      if (tool.access === "write") {
        expect(
          tool.annotations.readOnlyHint,
          `Tool ${tool.name} is access: "write" but does not declare readOnlyHint false`,
        ).toBe(false);
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
  test("every tool declares destructiveHint explicitly (boolean)", () => {
    for (const tool of defaultTools) {
      expect(
        typeof tool.annotations.destructiveHint,
        `Tool ${tool.name} must declare annotations.destructiveHint explicitly`,
      ).toBe("boolean");
    }
  });

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
 * body paragraphs, `configure_template_fields` field entries) carry their own snake_case
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
    expect([...new Set(issues)].toSorted()).toEqual(
      CAMEL_CASE_INPUT_PROPERTY_DEBT,
    );
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
      const outputNames = Object.keys(toolSet.outputs);

      expect(handlerNames.toSorted()).toEqual(definitionNames.toSorted());
      expect(outputNames.toSorted()).toEqual(definitionNames.toSorted());
    }
  });

  test.each(MCP_MODES)(
    "every %s wire tool advertises its executable output contract",
    (mode) => {
      const tools = toMcpTools(listStaticMcpToolDefinitions(mode), { mode });
      for (const tool of tools) {
        const contract = getStaticMcpToolOutputContract(tool.name, mode);
        expect(
          contract,
          `Missing output contract for ${tool.name}`,
        ).toBeDefined();
        expect(tool.outputSchema).toEqual(contract?.outputSchema);
      }
    },
  );

  test("static tool names are unique across tool sets", () => {
    const names = DEFAULT_MCP_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

/**
 * The generator's own tests read its output through its own eyes. These read
 * every published schema with an independent draft-07 validator: each one
 * compiles, and each compacted output schema accepts exactly the values its
 * uncompacted projection accepts, over values drawn from both schemas and
 * near misses of them.
 */
describe("MCP wire schemas under an independent validator", () => {
  const validator = createWireSchemaValidator();

  // Two sources that compact to one published schema are distinct inputs to
  // the equivalence check, so a contract is keyed by both projections.
  const contractKey = (
    contract: Pick<
      RuntimeMcpToolOutputContract,
      "outputSchema" | "outputSchemaSource"
    >,
  ): string =>
    JSON.stringify([
      contract.outputSchema,
      deriveUncompactedMcpOutputSchema(contract.outputSchemaSource),
    ]);

  const outputContracts = () => {
    const contracts = new Map<
      string,
      Pick<
        RuntimeMcpToolOutputContract,
        "outputSchema" | "outputSchemaSource"
      > & {
        tool: string;
      }
    >();
    for (const mode of MCP_MODES) {
      for (const tool of toMcpTools(listStaticMcpToolDefinitions(mode), {
        mode,
      })) {
        const contract = getStaticMcpToolOutputContract(tool.name, mode);
        if (contract !== undefined) {
          contracts.set(contractKey(contract), {
            tool: `${mode}/${tool.name}`,
            ...contract,
          });
        }
      }
    }
    for (const [family, policy] of Object.entries(
      DYNAMIC_TOOL_FAMILY_POLICIES,
    )) {
      if (policy.owner === "stella") {
        contracts.set(contractKey(policy.output), {
          tool: `family/${family}`,
          ...policy.output,
        });
      }
    }
    return [...contracts.values()];
  };

  test.each([...MCP_MODES])(
    "every %s input and output schema compiles",
    (mode) => {
      for (const tool of toMcpTools(listStaticMcpToolDefinitions(mode), {
        mode,
      })) {
        expect(
          () => compileWireSchema(validator, tool.inputSchema),
          `${tool.name} inputSchema`,
        ).not.toThrow();
        if (tool.outputSchema !== undefined) {
          const { outputSchema } = tool;
          expect(
            () => compileWireSchema(validator, outputSchema),
            `${tool.name} outputSchema`,
          ).not.toThrow();
        }
      }
    },
  );

  test("every output schema accepts exactly what its uncompacted projection accepts", () => {
    let compacted = 0;
    for (const {
      tool,
      outputSchema,
      outputSchemaSource,
    } of outputContracts()) {
      const uncompacted = deriveUncompactedMcpOutputSchema(outputSchemaSource);
      if (JSON.stringify(uncompacted) === JSON.stringify(outputSchema)) {
        continue;
      }
      compacted += 1;
      expect(
        JSON.stringify(outputSchema).length,
        `${tool} compacted output schema`,
      ).toBeLessThan(JSON.stringify(uncompacted).length);

      const acceptsCompacted = compileWireSchema(validator, outputSchema);
      const acceptsUncompacted = compileWireSchema(validator, uncompacted);
      let accepted = 0;
      let rejected = 0;
      fc.assert(
        fc.property(
          schemaComparisonArbitrary([uncompacted, outputSchema]),
          (value) => {
            const expected = acceptsUncompacted(value);
            // fast-check reports the value that disagreed.
            expect(acceptsCompacted(value), tool).toBe(expected);
            if (expected) {
              accepted += 1;
            } else {
              rejected += 1;
            }
          },
        ),
        propertyConfig({ numRuns: 200 }),
      );
      // Both verdicts must occur, or the comparison proved nothing.
      expect(accepted, `${tool} accepted no drawn value`).toBeGreaterThan(0);
      expect(rejected, `${tool} rejected no drawn value`).toBeGreaterThan(0);
    }
    expect(compacted).toBeGreaterThan(0);
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

describe("destructive write-tool behavior", () => {
  const writeTools = DEFAULT_MCP_TOOL_DEFINITIONS.filter(
    (tool) => tool.access === "write",
  );

  type WriteHintMetadata = Pick<
    Extract<McpToolDefinition, { access: "write" }>,
    "name" | "permissions" | "annotations" | "nonDestructiveReason"
  >;

  const needsUpdateDeleteHint = (tool: WriteHintMetadata) => {
    const authority = tool.permissions;
    let grants: readonly PermissionInput[];
    switch (authority.type) {
      case "all":
        grants = [authority.permissions];
        break;
      case "input":
        grants = selectableOperations(authority.select).map(
          ({ permissions }) => permissions,
        );
        break;
      case "any":
        grants = authority.alternatives;
        break;
      case "delegated":
        return true;
      default:
        authority satisfies never;
        return panic(`Unhandled tool authority: ${String(authority)}`);
    }
    return grants.some((grant) =>
      Object.values(grant).some((actions) =>
        actions.some(
          (action) =>
            action === "delete" ||
            (action === "update" && tool.nonDestructiveReason === undefined),
        ),
      ),
    );
  };

  const updateDeleteHintOffenders = (tools: readonly WriteHintMetadata[]) =>
    tools
      .filter(
        (tool) =>
          needsUpdateDeleteHint(tool) && !tool.annotations.destructiveHint,
      )
      .map((tool) => tool.name);

  test("every update or delete grant advertises a destructive hint", () => {
    expect(updateDeleteHintOffenders(writeTools)).toEqual([]);
  });

  test("the grant-derived guard detects incorrect metadata regardless of tool wording", () => {
    const guardedTools = writeTools.filter(needsUpdateDeleteHint);
    const mutations = guardedTools.map((tool, index) => ({
      name: `unrelated_${index}`,
      permissions: tool.permissions,
      annotations: { ...tool.annotations, destructiveHint: false },
    }));
    expect(guardedTools.some((tool) => tool.name === "compare_documents")).toBe(
      true,
    );
    expect(updateDeleteHintOffenders(mutations)).toEqual(
      mutations.map((tool) => tool.name),
    );
  });

  test("every grant exception states the handler's non-modifying behavior", () => {
    for (const tool of writeTools) {
      if (!("nonDestructiveReason" in tool)) {
        continue;
      }
      expect(tool.nonDestructiveReason.trim().length).toBeGreaterThan(0);
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });

  test("non-destructive tools declare no behavior except an outbound send", () => {
    const offenders = writeTools
      .filter((tool) => !tool.annotations.destructiveHint)
      .filter(
        (tool) =>
          "destructiveBehavior" in tool &&
          tool.destructiveBehavior !== undefined &&
          tool.destructiveBehavior.type !== "outbound",
      )
      .map((tool) => tool.name);
    expect(offenders).toEqual([]);
  });

  test("an outbound send is never advertised as a destructive operation", () => {
    // The two facts are independent and must not be conflated: `outbound`
    // gates the confirmation prompt, `destructiveHint` tells a client the call
    // can change existing stored data. A send destroys nothing.
    const offenders = defaultTools
      .filter(
        (tool) =>
          tool.destructiveBehavior?.type === "outbound" &&
          tool.annotations.destructiveHint,
      )
      .map((tool) => tool.name);
    expect(offenders).toEqual([]);
  });

  test("an outbound tool states what it sends, and advertises confirm", () => {
    const outbound = defaultTools.filter(
      (tool) => tool.destructiveBehavior?.type === "outbound",
    );
    expect(outbound.length).toBeGreaterThan(0);

    for (const tool of outbound) {
      const behavior = tool.destructiveBehavior;
      expect(behavior?.type === "outbound" ? behavior.reason : "").toContain(
        tool.name,
      );
      expect(Object.keys(getInputProperties(tool))).toContain("confirm");
      // The refusal names `confirm: true`; a description that never mentions
      // it leaves a model to discover the gate by being refused.
      expect(tool.description).toContain("confirm: true");
    }
  });
});

/**
 * Dynamic tool families are resolved per account, so no static registry row
 * can carry their contract. The family policy map is the registry instead:
 * every namespaced family decides who owns its output contract, and a
 * Stella-owned family's advertised schema must be derived from the executable
 * source that validates its results at dispatch.
 */
describe("MCP dynamic tool-family coherence", () => {
  const namespaces = Object.keys(DYNAMIC_TOOL_NAMESPACES);

  test("every namespaced family has a policy and every policy names a family", () => {
    expect(Object.keys(DYNAMIC_TOOL_FAMILY_POLICIES).toSorted()).toEqual(
      namespaces.toSorted(),
    );
  });

  test("the namespace census classifies every generated tool name", () => {
    expect(
      dynamicToolNamespaceOf(namespaceSkillToolName("summarize-c4ec37")),
    ).toBe("skill");
    expect(
      dynamicToolNamespaceOf(
        namespaceMcpToolName({ connectorSlug: "registry", toolName: "lookup" }),
      ),
    ).toBe("external_mcp");
    expect(dynamicToolNamespaceOf("list_matters")).toBeUndefined();
  });

  test("every Stella-owned family derives its advertised schema from its runtime source", () => {
    for (const policy of Object.values(DYNAMIC_TOOL_FAMILY_POLICIES)) {
      if (policy.owner !== "stella") {
        continue;
      }
      expect(policy.output.projection).toBe("identity");
      expect(policy.output.outputSchema).toEqual(
        defineMcpToolOutput(policy.output.outputSchemaSource).outputSchema,
      );
    }
  });

  test("every Stella-owned family is read-only, non-destructive and closed-world", () => {
    for (const policy of Object.values(DYNAMIC_TOOL_FAMILY_POLICIES)) {
      if (policy.owner !== "stella") {
        continue;
      }
      expect(policy.annotations).toEqual({
        destructiveHint: false,
        openWorldHint: false,
        readOnlyHint: true,
      });
    }
  });

  test("only Stella-owned families resolve an output contract by name", () => {
    expect(
      getDynamicMcpToolOutputContract(
        namespaceSkillToolName("summarize-c4ec37"),
      ),
    ).toBe(DYNAMIC_TOOL_FAMILY_POLICIES.skill.output);
    expect(
      getDynamicMcpToolOutputContract(
        namespaceMcpToolName({ connectorSlug: "registry", toolName: "lookup" }),
      ),
    ).toBeUndefined();
    expect(getDynamicMcpToolOutputContract("list_matters")).toBeUndefined();
  });
});

test("every served tool family fits the shared name contract", () => {
  const longestSlug = `${"a".repeat(SKILL_SLUG_MAX_LENGTH - 2)}-9`;
  const skillName = namespaceSkillToolName(longestSlug);
  expect(longestSlug).toHaveLength(SKILL_SLUG_MAX_LENGTH);
  expect(longestSlug.length + dynamicToolNamespacePrefix("skill").length).toBe(
    MCP_TOOL_NAME_MAX_LENGTH,
  );
  const seen = new Set<string>([skillName]);
  const dynamicNames = {
    skill: [
      namespaceSkillToolName("compare-default"),
      skillName,
      collisionSafeToolName({
        baseName: skillName,
        rawName: longestSlug,
        seen,
      }),
    ],
    external_mcp: [
      namespaceMcpToolName({
        connectorSlug: "Legal connector",
        toolName: "a".repeat(128),
      }),
    ],
  } satisfies Record<keyof typeof DYNAMIC_TOOL_NAMESPACES, string[]>;
  const names = [
    ...SURFACES.flatMap(({ definitions }) =>
      definitions.map(({ name }) => name),
    ),
    ...Object.values(dynamicNames).flat(),
  ];
  for (const name of names) {
    expect(name).toMatch(MCP_TOOL_NAME_PATTERN);
    expect(name.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX_LENGTH);
    expect(name.length).toBeLessThanOrEqual(EMITTED_TOOL_NAME_MAX_LENGTH);
  }
});
