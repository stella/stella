import { describe, expect, test } from "bun:test";

import {
  ANONYMIZED_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolOutputContract,
  LAW_MCP_TOOL_DEFINITIONS,
} from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";

/**
 * A tool description reaches a model as the complete contract, so a value it
 * names is a value the model will send or match a reply against. Naming one no
 * picklist admits is a bug, not a wording nit: `read_case_law_citations`
 * shipped promising treatments "followed, distinguished, overruled" while
 * returning a `polarity` drawn from `CITATION_TREATMENTS`, and no drift test
 * noticed.
 *
 * Descriptions quote a value in single quotes by convention, which makes the
 * class checkable without reading prose: every single-quoted token shaped like
 * a member of a closed vocabulary must be admitted by that tool's own
 * contract, or by the contract of a tool it names in the same description. The
 * vocabulary is read out of the schemas themselves rather than from a list
 * kept here, so renaming or dropping an enum member fails every description
 * still naming it.
 */

const SURFACES = [
  { mode: "default", definitions: DEFAULT_MCP_TOOL_DEFINITIONS },
  { mode: "anonymized", definitions: ANONYMIZED_MCP_TOOL_DEFINITIONS },
  { mode: "law", definitions: LAW_MCP_TOOL_DEFINITIONS },
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Where a schema node holds its declared property names. */
const PROPERTY_MAP_KEYS = ["properties", "entries"] as const;

/**
 * Everything a schema declares by name: the string literals its picklists
 * admit and the properties it advertises. Both are read from one walk because
 * a description quotes both kinds of name, and both must track the schema.
 *
 * The walk is structural rather than positional because the two schema
 * dialects on a definition spell the same facts differently and nest them at
 * unpredictable depths: a JSON Schema picklist is `enum` (or `const`) behind
 * `properties`/`items`/`anyOf`, while the executable Valibot schema spells it
 * `options`/`literal`/`enum` behind `entries`/`item`/`wrapped`/`pipe`. Reading
 * either dialect's keywords wherever they appear covers both without encoding
 * where each tool happens to declare its own.
 */
type SchemaNames = { literals: Set<string>; properties: Set<string> };

const addStrings = (value: unknown, into: Set<string>): void => {
  if (typeof value === "string") {
    into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const member of value) {
      if (typeof member === "string") {
        into.add(member);
      }
    }
  }
};

const collectSchemaNames = (
  schema: unknown,
  into: SchemaNames,
  seen: WeakSet<object>,
): SchemaNames => {
  if (Array.isArray(schema)) {
    if (seen.has(schema)) {
      return into;
    }
    seen.add(schema);
    for (const item of schema) {
      collectSchemaNames(item, into, seen);
    }
    return into;
  }
  if (!isRecord(schema) || seen.has(schema)) {
    return into;
  }
  seen.add(schema);

  // `enum` is a JSON Schema array of literals or a Valibot enum's value
  // record; `options` is a Valibot picklist's literals (a variant's branches
  // are objects, which `addStrings` skips).
  addStrings(schema["enum"], into.literals);
  if (isRecord(schema["enum"])) {
    addStrings(Object.values(schema["enum"]), into.literals);
  }
  addStrings(schema["const"], into.literals);
  addStrings(schema["literal"], into.literals);
  addStrings(schema["options"], into.literals);

  for (const key of PROPERTY_MAP_KEYS) {
    const properties = schema[key];
    if (isRecord(properties)) {
      addStrings(Object.keys(properties), into.properties);
    }
  }

  for (const value of Object.values(schema)) {
    collectSchemaNames(value, into, seen);
  }
  return into;
};

/**
 * One tool's declared names, read from its input schema plus both halves of
 * its output contract. `outputSchemaSource` is the executable schema and
 * `outputSchema` its advertised projection, which widens object internals past
 * a depth limit (`compactMcpOutputSchema`): a description may truthfully name
 * a value living under that limit, so the vocabulary comes from the source,
 * with the projection read too in case it ever carries a literal the source
 * does not.
 */
const declaredNames = (definition: McpToolDefinition): SchemaNames => {
  const names: SchemaNames = {
    literals: new Set<string>(),
    properties: new Set<string>(),
  };
  const seen = new WeakSet<object>();
  collectSchemaNames(definition.inputSchema, names, seen);
  const contract = getStaticMcpToolOutputContract(definition.name);
  collectSchemaNames(contract?.outputSchemaSource, names, seen);
  collectSchemaNames(contract?.outputSchema, names, seen);
  return names;
};

/**
 * A single-quoted span, with each quote required to be a delimiter rather than
 * an apostrophe. An English apostrophe sits between word characters
 * (`the user's matter`), so refusing a word character on the outer side of
 * each quote stops two possessives from pairing across half a sentence and
 * swallowing a real token in between.
 */
const QUOTED_SPAN = /(?<!\w)'([^'\n]*)'(?!\w)/gu;

/**
 * The shape a quoted span must have to read as naming a member of a closed
 * vocabulary: lowercase, letters/digits/underscore only, at least three
 * characters. Prose, placeholders (`'<uuid>'`), payload fragments, and
 * capitalised names do not match it, so none of them needs an exemption.
 */
const ENUM_SHAPED_TOKEN = /^[a-z][a-z0-9_]{2,}$/u;

const quotedEnumTokens = (description: string): readonly string[] => [
  ...new Set(
    [...description.matchAll(QUOTED_SPAN)]
      .map(([, span]) => span ?? "")
      .filter((span) => ENUM_SHAPED_TOKEN.test(span)),
  ),
];

/**
 * A description that tells the model which other tool to call next names that
 * tool and then quotes the argument to call it with (`read_case_law_citations
 * ({ decision_id: '<uuid>', direction: 'cited_by' })`). That value belongs to
 * the named tool's vocabulary, so the referenced tools' names are admitted
 * alongside the tool's own: still checked, just against the right contract. A
 * description that quotes a value without naming whose value it is stays a
 * failure.
 */
const referencedDefinitions = (
  definition: McpToolDefinition,
  registry: readonly McpToolDefinition[],
): readonly McpToolDefinition[] =>
  registry.filter(
    (other) =>
      other.name !== definition.name &&
      definition.description.includes(other.name),
  );

const admittedNames = (
  definition: McpToolDefinition,
  registry: readonly McpToolDefinition[],
): SchemaNames => {
  const admitted = declaredNames(definition);
  for (const referenced of referencedDefinitions(definition, registry)) {
    const other = declaredNames(referenced);
    for (const literal of other.literals) {
      admitted.literals.add(literal);
    }
    for (const property of other.properties) {
      admitted.properties.add(property);
    }
  }
  return admitted;
};

/**
 * Floors, not targets. Every assertion above is "no drift found", which is
 * also what a guard that reached nothing reports: a regex that stopped
 * matching the descriptions' convention, a schema walk that stopped
 * descending, or an import that resolved to an empty registry would all pass
 * silently. The counts are therefore part of the guard, and only move up.
 *
 * Measured at 8 tools and 15 tokens on the default surface; the floors sit
 * just under that, so rewording one description cannot trip them while a
 * broken extraction still does.
 */
const MIN_TOOLS_WITH_TOKENS = 6;
const MIN_TOKENS_CHECKED = 12;

describe("MCP tool descriptions only name values their own contract declares", () => {
  test.each([...SURFACES])(
    "$mode surface quotes no value outside the tool's vocabulary",
    ({ definitions }) => {
      const drifted: string[] = [];
      for (const definition of definitions) {
        const tokens = quotedEnumTokens(definition.description);
        if (tokens.length === 0) {
          continue;
        }
        const admitted = admittedNames(definition, definitions);
        for (const token of tokens) {
          if (admitted.literals.has(token) || admitted.properties.has(token)) {
            continue;
          }
          drifted.push(
            `${definition.name}: description quotes '${token}', which is neither a value its picklists admit (${[...admitted.literals].toSorted().join(", ") || "none"}) nor a property its schemas declare`,
          );
        }
      }

      expect(
        drifted,
        `A description names something the tool cannot take or return, so a model reading it will send or match a value that does not exist. Quote only names the schemas declare, render a value list from its vocabulary constant, and name the owning tool when the value belongs to another one:\n${drifted.join("\n")}`,
      ).toEqual([]);
    },
  );

  test("the check reaches a non-trivial share of the registry", () => {
    const inspected = DEFAULT_MCP_TOOL_DEFINITIONS.map((definition) => ({
      name: definition.name,
      tokens: quotedEnumTokens(definition.description),
    })).filter(({ tokens }) => tokens.length > 0);

    expect(
      inspected.length,
      `Only ${inspected.length} tools contributed a quoted token, so the extraction has probably stopped matching how descriptions quote values.`,
    ).toBeGreaterThanOrEqual(MIN_TOOLS_WITH_TOKENS);

    const tokensChecked = inspected.reduce(
      (total, { tokens }) => total + tokens.length,
      0,
    );
    expect(
      tokensChecked,
      `Only ${tokensChecked} quoted tokens were checked across the default surface.`,
    ).toBeGreaterThanOrEqual(MIN_TOKENS_CHECKED);

    // The tool whose description drifted has to be one the guard reaches.
    expect(
      inspected.find(({ name }) => name === "read_case_law_citations")?.tokens,
      "read_case_law_citations contributed no quoted token, so the tool this guard exists for is outside its reach.",
    ).not.toEqual([]);
  });

  test("a vocabulary is read from the executable schema, not its advertised projection", () => {
    const citations = DEFAULT_MCP_TOOL_DEFINITIONS.find(
      ({ name }) => name === "read_case_law_citations",
    );
    if (citations === undefined) {
      throw new Error("read_case_law_citations is missing from the registry");
    }
    const contract = getStaticMcpToolOutputContract(citations.name);
    const seen = new WeakSet<object>();
    const empty = (): SchemaNames => ({
      literals: new Set<string>(),
      properties: new Set<string>(),
    });

    const fromInput = collectSchemaNames(
      citations.inputSchema,
      empty(),
      seen,
    ).literals;
    const advertised = collectSchemaNames(
      contract?.outputSchema,
      empty(),
      new WeakSet<object>(),
    ).literals;
    const executable = collectSchemaNames(
      contract?.outputSchemaSource,
      empty(),
      new WeakSet<object>(),
    ).literals;

    // `direction` is input-only and the polarities are output-only, so a walk
    // reading one side would report the other's values as drift.
    expect(fromInput).toContain("cited_by");
    expect(fromInput.has("unclassified")).toBe(false);
    expect(executable).toContain("unclassified");

    // `passage.mention` sits below the advertised schema's detail depth, where
    // the projection widens the object to `additionalProperties: true`. The
    // guard must read the executable schema or it would call the description's
    // truthful 'latest_of_several' drift.
    expect(advertised.has("latest_of_several")).toBe(false);
    expect(executable).toContain("latest_of_several");
  });
});
