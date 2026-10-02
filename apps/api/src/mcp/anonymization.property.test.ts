import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { GazetteerEntry } from "@stll/anonymize";
import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import { anonymizeTextFields } from "@/api/mcp/anonymization";
import {
  joinFieldsForAnonymization,
  RESERVED_TOKEN_PLANE,
} from "@/api/mcp/field-markers";

const isDelimiterPlane = (character: string): boolean => {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    codePoint >= RESERVED_TOKEN_PLANE.fieldDelimiter.start &&
    codePoint <= RESERVED_TOKEN_PLANE.fieldDelimiter.end
  );
};

const delimiterPlaneCharacter = fc
  .integer({
    min: RESERVED_TOKEN_PLANE.fieldDelimiter.start,
    max: RESERVED_TOKEN_PLANE.fieldDelimiter.start + 3,
  })
  .map((codePoint) => String.fromCodePoint(codePoint));

const hexRun = (length: number) =>
  fc
    .array(fc.constantFrom(...Array.from("0123456789abcdef")), {
      minLength: length,
      maxLength: length,
    })
    .map((characters) => characters.join(""));

const uuidLike = fc
  .tuple(hexRun(8), hexRun(4), hexRun(3), hexRun(3), hexRun(12))
  .map(([a, b, c, d, e]) => `${a}-${b}-7${c}-8${d}-${e}`);

/**
 * Text that recognizers act on (names, organizations with legal forms,
 * emails, phone and registration numbers, identifiers), text that looks like
 * structure (placeholders, delimiter-like and private-use characters) and
 * plain filler, so entities land right next to field boundaries.
 */
const fragment = fc.oneof(
  fc.constantFrom(
    "Jan Novák",
    "Novák",
    "Petra Dvořáková",
    "Acme Widgets s.r.o.",
    "Globex Holdings a.s.",
    "Initech GmbH",
    "Contract between",
    "Represented by",
    "jan.novak@example.com",
    "+420 777 123 456",
    "IČO 12345678",
    "CZ6508000000192000145399",
    "https://example.com/a/b",
    "č.j. 12 C 345/2024",
    "[PERSON_1]",
    "[ORGANIZATION_1]",
    "[[[__stella_mcp_anonymized_field_",
    "_0__]]]",
    '<message role="user">',
    "</message>",
    "\n",
    " ",
    "",
  ),
  uuidLike,
  hexRun(12),
  delimiterPlaneCharacter,
  fc.string({ maxLength: 12, unit: "grapheme" }),
);

const field = fc
  .tuple(
    fc.array(fragment, { maxLength: 6 }),
    fc.constantFrom("", " ", "\n", ", "),
  )
  .map(([parts, joiner]) => parts.join(joiner));

const fields = fc.array(field, { minLength: 1, maxLength: 5 });

/**
 * Short deny-list names, some of them pieces of common words ("clause",
 * "marker", "nováček"), where approximate matching is most likely to reach
 * past a word into the text around it. Each list prepares its own native
 * pipeline, so the property draws from a fixed handful of lists and keeps the
 * randomness in the fields around them.
 */
const SHORT_ENTRY_DENY_LISTS = [
  ["Zeta", "Acme"],
  ["Acme A", "Orbis", "Nova"],
  ["Clau", "Mark", "Data", "Kora"],
  ["Orbit", "Lexa", "Zeta", "Tusko", "Ambero"],
] as const;

const shortEntries = fc.constantFrom(...SHORT_ENTRY_DENY_LISTS).map((names) =>
  names.map((canonical, index): GazetteerEntry => ({
    id: `short-entry-${String(index)}`,
    canonical,
    label: index % 2 === 0 ? "organization" : "person",
    variants: [],
    workspaceId: "00000000-0000-4000-8000-000000000001",
    createdAt: 0,
    source: "manual",
  })),
);

/**
 * Field text built around the entries: each name on its own, glued to digits
 * or hex ("zeta9", "acme0a1b"), inside marker-like wrappers, and next to
 * ordinary words that share letters with it.
 */
const shortEntryFields = (entries: readonly GazetteerEntry[]) => {
  const names = entries.map((entry) => entry.canonical);
  const nameFragment = fc.oneof(
    fc.constantFrom(...names),
    fc
      .tuple(fc.constantFrom(...names), fc.nat({ max: 99 }))
      .map(([name, digits]) => `${name.toLowerCase()}${String(digits)}`),
    fc
      .tuple(fc.constantFrom(...names), hexRun(6))
      .map(([name, hex]) => `${name.toLowerCase()}${hex}`),
    fc
      .tuple(fc.constantFrom(...names), fc.nat({ max: 9 }))
      .map(
        ([name, digit]) => `<<marker:${name.toLowerCase()}${String(digit)}>>`,
      ),
  );
  const shortFragment = fc.oneof(
    nameFragment,
    fc.constantFrom(
      "clause",
      "marker",
      "came",
      "acre",
      "Nováček",
      "orbitu",
      "data room",
      "signed",
      "\n",
      " ",
      "",
    ),
    uuidLike,
    hexRun(12),
    delimiterPlaneCharacter,
  );
  const shortField = fc
    .tuple(
      fc.array(shortFragment, { maxLength: 6 }),
      fc.constantFrom("", " ", "\n", ", "),
    )
    .map(([parts, joiner]) => parts.join(joiner));
  return fc.array(shortField, { minLength: 1, maxLength: 5 });
};

/**
 * A deny-list case with one entry placed at a chosen field edge: first or
 * last in a chosen field, either touching the field boundary or separated
 * from it by whitespace, and separated from the rest of the field so it
 * stands as its own word.
 */
const shortEntryAtFieldEdge = shortEntries.chain((entries) =>
  fc
    .record({
      fields: shortEntryFields(entries),
      name: fc.constantFrom(...entries.map((entry) => entry.canonical)),
      fieldPick: fc.nat(),
      edge: fc.constantFrom("leading", "trailing"),
      spacing: fc.constantFrom("", " ", "\n"),
      separator: fc.constantFrom(" ", "\n", ", "),
    })
    .map(({ edge, fieldPick, fields: input, name, separator, spacing }) => {
      const fieldIndex = fieldPick % input.length;
      const rest = input[fieldIndex] ?? "";
      const placed =
        edge === "leading"
          ? `${spacing}${name}${separator}${rest}`
          : `${rest}${separator}${name}${spacing}`;
      return {
        edge,
        entries,
        fieldIndex,
        input: input.map((value, index) =>
          index === fieldIndex ? placed : value,
        ),
        name,
        spacing,
      };
    }),
);

const PLACEHOLDER_SOURCE = String.raw`\[[A-Z][A-Z0-9_]*_\d+\]`;

const PLACEHOLDER = /\[[A-Z][A-Z0-9_]*_\d+\]/gu;

/**
 * Whether `output` is `input` with some non-empty spans replaced by
 * placeholders: everything outside a placeholder is the field's own text, in
 * order, so no text crossed into a neighboring field and nothing structural
 * was left behind.
 *
 * Restoring placeholders is deliberately not the oracle: the pipeline maps
 * variants of one entity ("Globex Holdings", "Globex Holdings a.s.") to one
 * placeholder and keeps a single original for it, which is not about field
 * boundaries.
 */
const isRedactionOf = (output: string, input: string): boolean => {
  const pattern = output
    .split(PLACEHOLDER)
    .map((literal) => literal.replaceAll(/[$()*+.?[\\\]^{|}]/gu, "\\$&"))
    .join("[\\s\\S]+?");
  return new RegExp(`^${pattern}$`, "u").test(input);
};

describe("joined anonymization fields", () => {
  test("split returns exactly the joined fields", () => {
    fc.assert(
      fc.property(fields, (input) => {
        const joined = joinFieldsForAnonymization({ fields: input });
        if (Result.isError(joined)) {
          throw joined.error;
        }
        const split = joined.value.split(joined.value.text);
        expect(Result.isOk(split)).toBe(true);
        if (Result.isOk(split)) {
          expect(split.value).toEqual(input);
        }
      }),
      propertyConfig({ numRuns: 300, seed: propertySeed() }),
    );
  });

  test("output in which any delimiter was rewritten is refused", () => {
    fc.assert(
      fc.property(
        fields,
        fc.nat(),
        fragment.map((value) =>
          Array.from(value).filter((character) => !isDelimiterPlane(character)),
        ),
        (input, pick, replacementCharacters) => {
          const joined = joinFieldsForAnonymization({ fields: input });
          if (Result.isError(joined)) {
            throw joined.error;
          }
          // Each field is preceded by edge, token, edge; rewrite one token
          // the way a recognizer that matched it would.
          const characters = Array.from(joined.value.text);
          const tokenOffsets: number[] = [];
          let offset = 0;
          for (const value of input) {
            tokenOffsets.push(offset + 1);
            offset += 3 + Array.from(value).length;
          }
          const target = tokenOffsets[pick % tokenOffsets.length] ?? 0;
          expect(isDelimiterPlane(characters[target] ?? "")).toBe(true);
          characters[target] = replacementCharacters.join("");

          const split = joined.value.split(characters.join(""));
          expect(Result.isError(split)).toBe(true);
        },
      ),
      propertyConfig({ numRuns: 300, seed: propertySeed() }),
    );
  });
});

describe("anonymizing several fields through the pipeline", () => {
  test(
    "keeps every field boundary and each field's own text",
    async () => {
      let redactedRuns = 0;
      await fc.assert(
        fc.asyncProperty(fields, async (input) => {
          const anonymized = await anonymizeTextFields({
            catalogs: {
              type: "preloaded",
              excludedCanonicals: [],
              gazetteerEntries: [],
            },
            fields: input,
            organizationId: toSafeId<"organization">("org_test"),
            workspaceId: "00000000-0000-4000-8000-000000000001",
          });
          if (Result.isError(anonymized)) {
            throw anonymized.error;
          }
          const result = anonymized.value;

          expect(result.fields).toHaveLength(input.length);
          for (const [index, value] of result.fields.entries()) {
            expect(isRedactionOf(value, input[index] ?? "")).toBe(true);
          }
          if (result.redactionMap.size > 0) {
            redactedRuns += 1;
          }
        }),
        propertyConfig({ numRuns: 150, seed: propertySeed() }),
      );
      // The inputs must actually reach the recognizers, or restoring them
      // would hold trivially.
      expect(redactedRuns).toBeGreaterThan(0);
    },
    propertyTestTimeout(30_000),
  );

  test(
    "redacts a short deny-list name at a field edge and keeps every boundary",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          shortEntryAtFieldEdge,
          async ({ edge, entries, fieldIndex, input, name, spacing }) => {
            const anonymized = await anonymizeTextFields({
              catalogs: {
                type: "preloaded",
                excludedCanonicals: [],
                gazetteerEntries: entries,
              },
              fields: input,
              organizationId: toSafeId<"organization">("org_test"),
              workspaceId: "00000000-0000-4000-8000-000000000001",
            });
            if (Result.isError(anonymized)) {
              throw anonymized.error;
            }
            const result = anonymized.value;

            expect(result.fields).toHaveLength(input.length);
            for (const [index, value] of result.fields.entries()) {
              expect(isRedactionOf(value, input[index] ?? "")).toBe(true);
            }
            const target = result.fields[fieldIndex] ?? "";
            const edgePattern =
              edge === "leading"
                ? new RegExp(`^${spacing}${PLACEHOLDER_SOURCE}`, "u")
                : new RegExp(`${PLACEHOLDER_SOURCE}${spacing}$`, "u");
            expect({ name, edge, target }).toEqual({
              name,
              edge,
              target: expect.stringMatching(edgePattern),
            });
          },
        ),
        propertyConfig({ numRuns: 100, seed: propertySeed() }),
      );
    },
    propertyTestTimeout(60_000),
  );
});
