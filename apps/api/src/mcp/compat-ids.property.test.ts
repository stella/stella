import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { propertyConfig } from "@stll/property-testing";

import {
  compatCorpusIdInputSchema,
  compatIdInputSchema,
  decodeCompatCorpusId,
  decodeCompatId,
  encodeCompatId,
  type CompatId,
} from "@/api/mcp/compat-ids";

/**
 * `search` writes an id and `fetch` reads it back. The property that matters is
 * not that a handful of examples survive the trip but that the whole id class
 * does: every id the writer can mint decodes to the value it was minted from,
 * and the schema a client is shown admits exactly those.
 */
const uuidArbitrary = fc
  .uuid()
  .map((value) => value.toLowerCase())
  .chain((lower) =>
    fc.constantFrom(lower, lower.toUpperCase(), lower.toUpperCase()),
  );

/** An ELI is a publisher path; the reader bounds its length, not its shape. */
const eliArbitrary = fc
  .string({ minLength: 1, maxLength: 120 })
  .filter((value) => !value.includes("\n") && !value.includes("\r"));

const compatIdArbitrary: fc.Arbitrary<CompatId> = fc.oneof(
  uuidArbitrary.map((entityId) => ({ kind: "document" as const, entityId })),
  uuidArbitrary.map((decisionId) => ({
    kind: "decision" as const,
    decisionId,
  })),
  eliArbitrary.map((eli) => ({ kind: "statute" as const, eli })),
);

const idSchema = compatIdInputSchema("id");
const corpusIdSchema = compatCorpusIdInputSchema("id");

describe("compat id vocabulary", () => {
  test("every minted id decodes back to what minted it", () => {
    fc.assert(
      fc.property(compatIdArbitrary, (id) => {
        expect(decodeCompatId(encodeCompatId(id))).toEqual(id);
      }),
      propertyConfig(),
    );
  });

  test("the declared schema admits exactly the ids the reader admits", () => {
    fc.assert(
      fc.property(compatIdArbitrary, (id) => {
        const wire = encodeCompatId(id);
        expect(v.safeParse(idSchema, wire).success).toBe(true);
        // The corpus-only audience refuses a document id and admits the rest.
        expect(v.safeParse(corpusIdSchema, wire).success).toBe(
          id.kind !== "document",
        );
        expect(decodeCompatCorpusId(wire)).toEqual(
          id.kind === "document" ? null : id,
        );
      }),
      propertyConfig(),
    );
  });

  test("a value outside the vocabulary is refused by the schema and the reader", () => {
    fc.assert(
      fc.property(
        fc
          .string({ maxLength: 60 })
          .filter((raw) => decodeCompatId(raw) === null),
        (raw) => {
          expect(v.safeParse(idSchema, raw).success).toBe(false);
        },
      ),
      propertyConfig(),
    );
  });

  test("the ids a client already holds keep their meaning", () => {
    // A bare uuid minted before the corpus reached this pair is sitting in
    // clients' conversations; it must still read as a matter document.
    expect(decodeCompatId("00000000-0000-4000-8000-0000000e0001")).toEqual({
      kind: "document",
      entityId: "00000000-0000-4000-8000-0000000e0001",
    });
  });

  test("a prefix without its payload is not an id", () => {
    expect(decodeCompatId("decision:")).toBeNull();
    expect(decodeCompatId("statute:")).toBeNull();
    expect(decodeCompatId("decision:not-a-uuid")).toBeNull();
  });
});
