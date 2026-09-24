/**
 * Census: a cursor a client made up reads as no cursor.
 *
 * A client that must fill every declared property has nothing to put in
 * `cursor` on a first call, so it puts a placeholder there: a space, a dot,
 * `0`, `start`. Answering `Invalid cursor` tells a caller holding no cursor to
 * fix one, so it invents another placeholder and the tool never returns a
 * first page. `cursorInput` therefore reads a value outside the issued class
 * as absence, and this walks the registry to require that of every cursor
 * property rather than of the ones that remembered to opt in.
 *
 * The opposite direction matters as much and is asserted below: a real cursor
 * that arrives damaged is inside the class, so it still reaches the tool's
 * decoder and still fails there. Silently restarting that caller at page one
 * would repeat a page it had already read.
 */

import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  encodePaginationCursor,
  isIssuablePaginationCursor,
} from "@/api/lib/pagination";
import { isRecord } from "@/api/lib/type-guards";
import { ALL_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

/**
 * Cursor values observed from a client filling every declared property. Kept
 * verbatim: the list is evidence, not a grammar, and a rule derived from it
 * would be the thing under test.
 */
const MADE_UP_CURSORS = [
  " ",
  ". ",
  ". .",
  ". . .",
  ".  ",
  "0",
  "x",
  " x",
  "a",
  "/",
  ".",
  "__",
  "null",
  "no",
  "new",
  "reset",
  "start",
  "START",
  "initial",
  "first",
  "__start__",
  ".? no",
] as const;

/**
 * Invented values a tool keeps because they name the first page anyway. The
 * BOE numbers its pages from zero, so offset `0` answers exactly what omitting
 * the cursor answers.
 */
const MADE_UP_CURSOR_NAMES_FIRST_PAGE = new Set([
  'search_boe_legislation.cursor <- "0"',
]);

const definitionsWithRuntimeSchema = ALL_MCP_TOOL_DEFINITIONS.filter(
  (definition) => "inputSchemaSource" in definition,
);

/** A cursor under any name: `cursor`, `versions_cursor`, `text_cursor`. */
const isCursorProperty = (name: string): boolean => name.endsWith("cursor");

/** Advertised cursor properties a caller may omit. */
const cursorProperties = (schema: unknown): string[] => {
  if (!isRecord(schema)) {
    return [];
  }
  const { properties, required } = schema;
  const requiredNames = new Set(
    Array.isArray(required)
      ? required.filter((name) => typeof name === "string")
      : [],
  );
  return isRecord(properties)
    ? Object.keys(properties).filter(
        (name) => isCursorProperty(name) && !requiredNames.has(name),
      )
    : [];
};

/** Every (tool, cursor property) pair the registry declares with a validator. */
const cursorSites = definitionsWithRuntimeSchema.flatMap((definition) =>
  cursorProperties(definition.inputSchema).map((property) => ({
    definition,
    property,
  })),
);

const CURSOR_READING = {
  absent: "absent",
  refused: "refused",
} as const;

/**
 * How one tool reads one cursor value, isolated from the rest of its input: a
 * tool whose other properties are required fails on them whatever the cursor
 * says, so a whole-object outcome would hide the answer behind that failure.
 */
const cursorReading = (
  schema: v.GenericSchema,
  property: string,
  value: unknown,
): string => {
  const parsed = v.safeParse(schema, { [property]: value });
  if (parsed.issues?.some((issue) => v.getDotPath(issue) === property)) {
    return CURSOR_READING.refused;
  }
  const { output } = parsed;
  return isRecord(output) && output[property] !== undefined
    ? `value:${JSON.stringify(output[property])}`
    : CURSOR_READING.absent;
};

/** A real cursor, cut short: still readable text, no longer a page boundary. */
const TRUNCATED_REAL_CURSOR = encodePaginationCursor([
  "2026-01-01T00:00:00.000Z",
  "6f1c3a52-0000-4000-8000-000000000001",
]).slice(0, 16);

describe("MCP cursor inputs read a made-up cursor as no cursor", () => {
  test("no tool reads an invented cursor as a page boundary", () => {
    const accepted: string[] = [];
    for (const { definition, property } of cursorSites) {
      for (const madeUp of MADE_UP_CURSORS) {
        const site = `${definition.name}.${property} <- ${JSON.stringify(madeUp)}`;
        const reading = cursorReading(
          definition.inputSchemaSource,
          property,
          madeUp,
        );
        if (
          reading !== CURSOR_READING.absent &&
          !MADE_UP_CURSOR_NAMES_FIRST_PAGE.has(site)
        ) {
          accepted.push(`${site} (${reading})`);
        }
      }
    }

    expect(
      accepted,
      `These cursor properties read an invented value as a cursor, so a client that fills every declared property is refused instead of answered with a first page: ${accepted.join(", ")}. Declare each with cursorInput from tool-utils.`,
    ).toEqual([]);
  });

  test("null and the empty string stay absent too", () => {
    const accepted: string[] = [];
    for (const { definition, property } of cursorSites) {
      for (const placeholder of [null, ""]) {
        const reading = cursorReading(
          definition.inputSchemaSource,
          property,
          placeholder,
        );
        if (reading !== CURSOR_READING.absent) {
          accepted.push(
            `${definition.name}.${property} <- ${JSON.stringify(placeholder)} (${reading})`,
          );
        }
      }
    }

    expect(accepted).toEqual([]);
  });

  test("a truncated real cursor stays a cursor, so its decoder still refuses it", () => {
    // The premise: the cut cursor is still in the issued class, so what keeps
    // it out of the first page is the decoder, not this rule.
    expect(isIssuablePaginationCursor(TRUNCATED_REAL_CURSOR)).toBe(true);

    const dropped: string[] = [];
    for (const { definition, property } of cursorSites) {
      // `search_boe_legislation` is the one exception: the BOE numbers its own
      // pages, so a base64 string is not a boundary it ever issued.
      if (definition.name === "search_boe_legislation") {
        continue;
      }
      const reading = cursorReading(
        definition.inputSchemaSource,
        property,
        TRUNCATED_REAL_CURSOR,
      );
      if (reading !== `value:${JSON.stringify(TRUNCATED_REAL_CURSOR)}`) {
        dropped.push(`${definition.name}.${property} (${reading})`);
      }
    }

    expect(
      dropped,
      `A damaged cursor read as absence restarts a caller at page one and repeats a page it has already read: ${dropped.join(", ")}.`,
    ).toEqual([]);
  });

  test("search_boe_legislation reads the decimal offsets it issues", () => {
    const definition = definitionsWithRuntimeSchema.find(
      ({ name }) => name === "search_boe_legislation",
    );
    if (definition === undefined) {
      throw new Error("search_boe_legislation is not registered");
    }
    expect(cursorReading(definition.inputSchemaSource, "cursor", "20")).toBe(
      'value:"20"',
    );
    expect(cursorReading(definition.inputSchemaSource, "cursor", "start")).toBe(
      CURSOR_READING.absent,
    );
  });

  test("the walk covers the cursor properties the registry declares", () => {
    // Anti-vacuity: a name rule matching nothing would satisfy every
    // assertion above while asserting nothing at all.
    const covered = cursorSites.map(
      ({ definition, property }) => `${definition.name}.${property}`,
    );

    expect(covered.length).toBeGreaterThan(20);
    expect(covered).toContain("search_case_law.cursor");
    expect(covered).toContain("read_document.versions_cursor");
    expect(covered).toContain("search_boe_legislation.cursor");
    expect(covered).toContain("search_legislation.cursor");
    expect(covered).toContain("list_time_entries.cursor");
  });
});
