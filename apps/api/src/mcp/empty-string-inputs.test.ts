import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { ALL_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

/**
 * A model that fills every property it sees sends `""` for the optional ones
 * it has nothing to say about, the same way a strict tool-schema client sends
 * `null`. On a filter or a cursor, `""` is worse than `null`: it is a value
 * the type admits, so it narrows the search to court "" or resumes from
 * cursor "" instead of leaving the filter unset.
 *
 * The fix is declarative and already built: the tool factory reads `""` as
 * absent for exactly those properties whose own schema rejects it
 * (`ABSENT_PLACEHOLDERS` in `tool-utils.ts`), so a filter needs only
 * `v.minLength(1)` for the factory to drop it. This walks the registry and
 * requires the property to hold, tool by tool, instead of trusting each new
 * filter to opt in.
 */
const definitionsWithRuntimeSchema = ALL_MCP_TOOL_DEFINITIONS.filter(
  (definition) => "inputSchemaSource" in definition,
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The property kinds for which no empty string is a value a caller could
 * mean: a filter narrows to a name the corpus holds, a code is drawn from a
 * closed vocabulary, a cursor is a page boundary this API itself issued.
 *
 * Free text is deliberately absent. A title, a note or a message may be
 * legitimately empty, and forcing a minimum length on one would reject a call
 * the tool should accept.
 */
const NARROWING_PROPERTY_NAMES = new Set([
  "country",
  "court",
  "decision_type",
  "document_type",
  "language",
  "sort",
  "source_id",
  "status",
]);

/** A cursor under any name: `cursor`, `text_cursor`, `citations_cursor`. */
const isCursorProperty = (name: string): boolean => name.endsWith("cursor");

const isNarrowingProperty = (name: string): boolean =>
  NARROWING_PROPERTY_NAMES.has(name) || isCursorProperty(name);

/** Advertised properties a caller may omit: the ones "" can be sent for. */
const optionalProperties = (schema: unknown): string[] => {
  if (!isRecord(schema)) {
    return [];
  }
  const properties = schema["properties"];
  const required = schema["required"];
  const requiredNames = new Set(
    Array.isArray(required)
      ? required.filter((name) => typeof name === "string")
      : [],
  );
  return isRecord(properties)
    ? Object.keys(properties).filter((name) => !requiredNames.has(name))
    : [];
};

/**
 * The outcome of a parse, reduced to what a caller sees. Two inputs that read
 * the same way produce the same string, whether they both parse or both fail
 * on the same rule.
 */
const parseOutcome = (schema: v.GenericSchema, input: unknown): string => {
  const parsed = v.safeParse(schema, input);
  return parsed.success
    ? `ok:${JSON.stringify(parsed.output)}`
    : parsed.issues
        .map(
          (issue) =>
            `${(issue.path ?? []).map(({ key }) => String(key)).join(".")}: ${issue.message}`,
        )
        .toSorted()
        .join(" | ");
};

describe("MCP filter and cursor inputs read an empty string as unset", () => {
  test("no optional filter, code or cursor accepts the empty string as a value", () => {
    const accepted: string[] = [];
    for (const definition of definitionsWithRuntimeSchema) {
      const omitted = parseOutcome(definition.inputSchemaSource, {});
      for (const property of optionalProperties(definition.inputSchema)) {
        if (!isNarrowingProperty(property)) {
          continue;
        }
        const withEmpty = parseOutcome(definition.inputSchemaSource, {
          [property]: "",
        });
        if (withEmpty !== omitted) {
          accepted.push(`${definition.name}.${property}`);
        }
      }
    }

    expect(
      accepted,
      `These optional properties read an empty string as a value rather than as unset, so a model that fills every property narrows the call to "" instead of leaving the property alone: ${accepted.join(", ")}. Add v.minLength(1) to each, which is what makes the tool factory drop it.`,
    ).toEqual([]);
  });

  test("the rule covers the properties it is written for", () => {
    // Anti-vacuity: a name rule that matched nothing would pass the test
    // above while asserting nothing at all.
    const covered: string[] = [];
    for (const definition of definitionsWithRuntimeSchema) {
      for (const property of optionalProperties(definition.inputSchema)) {
        if (isNarrowingProperty(property)) {
          covered.push(`${definition.name}.${property}`);
        }
      }
    }

    expect(covered).toContain("search_case_law.court");
    expect(covered).toContain("search_case_law.cursor");
    expect(covered).toContain("search_case_law.language");
    expect(covered).toContain("search_case_law.decision_type");
    expect(covered).toContain("search_legislation.status");
    expect(covered).toContain("search_legislation.document_type");
  });
});
