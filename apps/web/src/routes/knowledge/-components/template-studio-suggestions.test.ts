import type { Node as PMNode } from "@tiptap/pm/model";
import { Schema } from "@tiptap/pm/model";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  buildPositionalText,
  resolveSuggestionAnchor,
} from "@stll/folio-react";
import { assertProperty } from "@stll/property-testing";

import {
  buildOperationSpecs,
  buildReplacementSuggestions,
  extractCompletedStreamingOperations,
  extractFieldMarkerPath,
  operationFingerprint,
} from "./template-studio-suggestions";
import type {
  BuildReplaceSpecArgs,
  DocxEditOperation,
  ReplacementSpec,
} from "./template-studio-suggestions";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    text: {},
  },
});

const PROPERTY_MAX_PARAGRAPHS = 4;
const PROPERTY_MAX_SPECS = 6;
const PROPERTY_MAX_OCCUPIED_RANGES = 5;
const PROPERTY_MAX_RANGE_LENGTH = 32;
const PROPERTY_MAX_TEXT_PARTS = 18;
const PROPERTY_MAX_SEARCH_TOKENS = 4;
const PROPERTY_MIN_PARAGRAPHS = 1;
const PROPERTY_CONTEXT_CHARS = 24;
const SEARCH_TEXT_ATOMS = Object.freeze([
  "a",
  "Acme",
  "café",
  "Čapkovým",
  "e\u0301",
  "😀",
  " ",
  "+",
  "[",
  "\ud800",
  "\udc00",
  "\ufffd",
]);
const searchTextArbitrary = fc
  .array(fc.constantFrom(...SEARCH_TEXT_ATOMS), {
    maxLength: PROPERTY_MAX_TEXT_PARTS,
  })
  .map((parts) => parts.join(""));
const searchLiteralArbitrary = fc.constantFrom(
  "a",
  "Acme",
  "café",
  "Čapkov",
  "fé",
  "e\u0301",
  "😀",
  "+",
  "[",
  "",
);

const makeDoc = (paragraphs: string[]) =>
  schema.node(
    "doc",
    null,
    paragraphs.map((p) =>
      schema.node("paragraph", null, p.length === 0 ? [] : [schema.text(p)]),
    ),
  );

const spec = (partial: Partial<ReplacementSpec>): ReplacementSpec => ({
  id: partial.id ?? "op-1",
  literalText: partial.literalText ?? "",
  suggestedText: partial.suggestedText ?? "",
  topic: partial.topic ?? "t",
  rationale: partial.rationale ?? "",
  ...(partial.scopeText === undefined ? {} : { scopeText: partial.scopeText }),
  ...(partial.display === undefined ? {} : { display: partial.display }),
  ...(partial.registerMeta === undefined
    ? {}
    : { registerMeta: partial.registerMeta }),
});

type PreviousSuggestionProjectionOptions = {
  doc: PMNode;
  occupiedRanges: readonly { from: number; to: number }[];
  specs: readonly ReplacementSpec[];
};

const previousSuggestionProjection = ({
  doc,
  occupiedRanges,
  specs,
}: PreviousSuggestionProjectionOptions) => {
  const positional = buildPositionalText(doc);
  const haystack = positional.text;
  const searchHaystack = haystack.toWellFormed();
  const suggestions: {
    contextAfter: string;
    contextBefore: string;
    originalText: string;
    range: { from: number; to: number };
    rationale: string;
    severity: "substantive";
    status: "pending";
    suggestedText: string;
    topic: string;
  }[] = [];
  const placedSpecIds = new Set<string>();
  const occupied = [...occupiedRanges];

  for (const candidateSpec of specs) {
    if (candidateSpec.literalText.length === 0) {
      continue;
    }

    let regionStart = 0;
    let regionEnd = haystack.length;
    if (
      candidateSpec.scopeText !== undefined &&
      candidateSpec.scopeText.length > 0
    ) {
      const normalizedScopeText = candidateSpec.scopeText.toWellFormed();
      const scopeIndex = searchHaystack.indexOf(normalizedScopeText);
      if (scopeIndex !== -1) {
        regionStart = scopeIndex;
        regionEnd = scopeIndex + normalizedScopeText.length;
      }
    }

    const normalizedLiteralText = candidateSpec.literalText.toWellFormed();
    let matchIndex = searchHaystack.indexOf(normalizedLiteralText, regionStart);
    while (
      matchIndex !== -1 &&
      matchIndex + normalizedLiteralText.length <= regionEnd
    ) {
      const from = positional.pmPositionAt(matchIndex);
      const to =
        positional.pmPositionAt(matchIndex + normalizedLiteralText.length - 1) +
        1;
      const overlaps = occupied.some(
        (range) => from < range.to && to > range.from,
      );
      if (!overlaps) {
        occupied.push({ from, to });
        placedSpecIds.add(candidateSpec.id);
        suggestions.push({
          contextBefore: haystack.slice(
            Math.max(0, matchIndex - PROPERTY_CONTEXT_CHARS),
            matchIndex,
          ),
          contextAfter: haystack.slice(
            matchIndex + normalizedLiteralText.length,
            matchIndex + normalizedLiteralText.length + PROPERTY_CONTEXT_CHARS,
          ),
          originalText: haystack.slice(
            matchIndex,
            matchIndex + normalizedLiteralText.length,
          ),
          range: { from, to },
          rationale: candidateSpec.rationale,
          severity: "substantive",
          status: "pending",
          suggestedText: candidateSpec.suggestedText,
          topic: candidateSpec.topic,
        });
      }
      matchIndex = searchHaystack.indexOf(
        normalizedLiteralText,
        matchIndex + normalizedLiteralText.length,
      );
    }
  }

  return {
    placedSpecIds: [...placedSpecIds],
    suggestions: suggestions.toSorted(
      (left, right) => left.range.from - right.range.from,
    ),
  };
};

describe("buildReplacementSuggestions", () => {
  test("matches the previous scoped, ordered literal-scan outputs for generated inputs", () => {
    const generatedParagraphs = fc
      .array(
        fc.array(fc.constantFrom(...SEARCH_TEXT_ATOMS), {
          maxLength: PROPERTY_MAX_SEARCH_TOKENS,
        }),
        {
          minLength: PROPERTY_MIN_PARAGRAPHS,
          maxLength: PROPERTY_MAX_PARAGRAPHS,
        },
      )
      .map((paragraphs) => paragraphs.map((parts) => parts.join(" ")));
    const generatedSpecs = fc.array(
      fc.record({
        id: searchTextArbitrary,
        literalText: searchLiteralArbitrary,
        rationale: searchTextArbitrary,
        scopeText: fc.option(searchTextArbitrary, { nil: undefined }),
        suggestedText: searchTextArbitrary,
        topic: searchTextArbitrary,
      }),
      { maxLength: PROPERTY_MAX_SPECS },
    );
    const generatedOccupiedRanges = fc.array(
      fc.tuple(
        fc.nat({ max: PROPERTY_MAX_RANGE_LENGTH }),
        fc.nat({ max: PROPERTY_MAX_RANGE_LENGTH }),
      ),
      { maxLength: PROPERTY_MAX_OCCUPIED_RANGES },
    );

    assertProperty(
      "matches the previous scoped, ordered literal-scan outputs for generated inputs",
      fc.property(
        generatedParagraphs,
        generatedSpecs,
        generatedOccupiedRanges,
        (paragraphs, rawSpecs, rawOccupiedRanges) => {
          const doc = makeDoc(paragraphs);
          const oracleSpecs = rawSpecs.map((candidate) => {
            const { scopeText, ...candidateFields } = candidate;
            return {
              ...candidateFields,
              literalText: candidate.literalText,
              ...(scopeText === undefined ? {} : { scopeText }),
            };
          });
          const maxPosition = doc.content.size;
          const occupiedRanges = rawOccupiedRanges.map(([start, length]) => {
            const from = start % (maxPosition + 1);
            const to = Math.min(maxPosition, from + length);
            return { from, to };
          });
          const expected = previousSuggestionProjection({
            doc,
            occupiedRanges,
            specs: oracleSpecs,
          });
          const actual = buildReplacementSuggestions(doc, oracleSpecs, {
            occupiedRanges,
          });

          expect(actual.placedSpecIds).toEqual(new Set(expected.placedSpecIds));
          expect(
            actual.suggestions.map(
              ({
                contextAfter,
                contextBefore,
                originalText,
                range,
                rationale,
                severity,
                status,
                suggestedText,
                topic,
              }) => ({
                contextAfter,
                contextBefore,
                originalText,
                range,
                rationale,
                severity,
                status,
                suggestedText,
                topic,
              }),
            ),
          ).toEqual(expected.suggestions);
        },
      ),
    );
  });

  test("contexts come from positional text so anchors re-resolve", () => {
    const doc = makeDoc(["Seller: Acme Inc.", "Buyer: Beta s.r.o."]);
    const { suggestions } = buildReplacementSuggestions(doc, [
      spec({ literalText: "Beta s.r.o.", suggestedText: "{{buyer.name}}" }),
    ]);

    expect(suggestions).toHaveLength(1);
    const suggestion = suggestions[0];
    if (!suggestion) {
      throw new Error("expected a suggestion");
    }
    // The context window crosses the block boundary — positional text
    // joins blocks with "\n"; any other separator breaks re-anchoring.
    expect(suggestion.contextBefore).toContain("\n");
    expect(suggestion.contextBefore.endsWith("Buyer: ")).toBe(true);
    const anchor = resolveSuggestionAnchor(doc, suggestion);
    expect(anchor).toEqual(suggestion.range);
    expect(
      doc.textBetween(suggestion.range.from, suggestion.range.to, "\n"),
    ).toBe("Beta s.r.o.");
  });

  test("scopeText confines the search to the operation's block", () => {
    const doc = makeDoc([
      "Acme Inc. delivers the goods.",
      "Acme Inc. signs below.",
    ]);
    const { suggestions, placedSpecIds } = buildReplacementSuggestions(doc, [
      spec({
        id: "op-second-block",
        literalText: "Acme Inc.",
        suggestedText: "{{company.name}}",
        scopeText: "Acme Inc. signs below.",
      }),
    ]);

    expect(placedSpecIds.has("op-second-block")).toBe(true);
    expect(suggestions).toHaveLength(1);
    expect(
      doc.textBetween(
        suggestions[0]?.range.from ?? 0,
        suggestions[0]?.range.to ?? 0,
        "\n",
      ),
    ).toBe("Acme Inc.");
    // Anchored in the second paragraph, not the first occurrence.
    expect(suggestions[0]?.contextBefore ?? "").toContain("goods.");
  });

  test("well-forms malformed text for matching and never matches half an astral character", () => {
    for (const malformedText of ["left\ud800right", "left\udc00right"]) {
      const malformedDocument = makeDoc([malformedText]);
      const replacementSuggestions = buildReplacementSuggestions(
        malformedDocument,
        [spec({ literalText: "\ufffd", suggestedText: "replacement" })],
      );
      expect(replacementSuggestions.suggestions).toHaveLength(1);
      const suggestion = replacementSuggestions.suggestions[0];
      if (!suggestion) {
        throw new Error("expected a malformed-text suggestion");
      }
      expect(suggestion.originalText).toBe(malformedText.slice(4, 5));
      expect(resolveSuggestionAnchor(malformedDocument, suggestion)).toEqual(
        suggestion.range,
      );
    }

    const astralDocument = makeDoc(["😀"]);
    expect(
      buildReplacementSuggestions(astralDocument, [
        spec({ literalText: "\ud83d", suggestedText: "high half" }),
        spec({ id: "low", literalText: "\ude00", suggestedText: "low half" }),
      ]).suggestions,
    ).toEqual([]);
  });

  test("unmatched literals report as not placed; matched specs map every occurrence without overlap", () => {
    const doc = makeDoc(["Jan Novak and Jan Novak agree."]);
    const { suggestions, placedSpecIds } = buildReplacementSuggestions(doc, [
      spec({
        id: "op-name",
        literalText: "Jan Novak",
        suggestedText: "{{party.name}}",
      }),
      // Overlaps the first spec's spans — first spec wins per range.
      spec({ id: "op-overlap", literalText: "Novak and Jan" }),
      spec({ id: "op-missing", literalText: "Not in the document" }),
    ]);

    expect(suggestions).toHaveLength(2);
    expect(placedSpecIds.has("op-name")).toBe(true);
    expect(placedSpecIds.has("op-overlap")).toBe(false);
    expect(placedSpecIds.has("op-missing")).toBe(false);
  });
});

const buildReplaceSpec = (args: BuildReplaceSpecArgs): ReplacementSpec =>
  spec({
    id: args.id,
    literalText: args.find,
    suggestedText: args.replace,
    topic: args.area,
    ...(args.scopeText === undefined ? {} : { scopeText: args.scopeText }),
  });

describe("buildOperationSpecs", () => {
  test("replaceInBlock with an unknown blockId degrades to a whole-document literal search", () => {
    const doc = makeDoc(["KRS register.", "Company KRS no. 0000123456."]);
    const operation: DocxEditOperation = {
      type: "replaceInBlock",
      blockId: "not-in-any-snapshot",
      find: "0000123456",
      replace: "{{company.krs}}",
      severity: "medium",
      area: "Identifiers",
    };

    const { specs, skipped } = buildOperationSpecs({
      operations: [operation],
      blockTextById: new Map(),
      buildReplaceSpec,
    });

    expect(skipped).toHaveLength(0);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.scopeText).toBeUndefined();

    const { suggestions, placedSpecIds } = buildReplacementSuggestions(
      doc,
      specs,
    );
    expect(placedSpecIds.has("tpl-edit-1-not-in-any-snapshot")).toBe(true);
    expect(suggestions).toHaveLength(1);
    expect(
      doc.textBetween(
        suggestions[0]?.range.from ?? 0,
        suggestions[0]?.range.to ?? 0,
        "\n",
      ),
    ).toBe("0000123456");
  });

  test("replaceBlock and deleteBlock still need the snapshot block for their literal", () => {
    const { specs, skipped } = buildOperationSpecs({
      operations: [
        {
          type: "replaceBlock",
          blockId: "unknown-a",
          text: "New text.",
          severity: "high",
          area: "General",
        },
        {
          type: "deleteBlock",
          blockId: "unknown-b",
          severity: "low",
          area: "General",
        },
      ],
      blockTextById: new Map(),
      buildReplaceSpec,
    });

    expect(specs).toHaveLength(0);
    expect(skipped).toEqual([
      { id: "tpl-edit-1-unknown-a", reason: "missingBlock" },
      { id: "tpl-edit-2-unknown-b", reason: "missingBlock" },
    ]);
  });

  test("startIndex keeps spec ids aligned with the full operation list", () => {
    const { specs } = buildOperationSpecs({
      operations: [
        {
          type: "replaceInBlock",
          blockId: "B1",
          find: "Acme",
          replace: "{{seller.name}}",
          severity: "low",
          area: "Names",
        },
      ],
      startIndex: 4,
      blockTextById: new Map([["B1", "Acme delivers."]]),
      buildReplaceSpec,
    });

    expect(specs[0]?.id).toBe("tpl-edit-5-B1");
    expect(specs[0]?.scopeText).toBe("Acme delivers.");
  });
});

describe("buildReplacementSuggestions occupiedRanges", () => {
  test("pre-claimed spans are skipped so progressive batches stay duplicate-free", () => {
    const doc = makeDoc(["Acme Inc. delivers. Acme Inc. signs."]);
    const firstPass = buildReplacementSuggestions(doc, [
      spec({ id: "op-1", literalText: "Acme Inc." }),
    ]);
    expect(firstPass.suggestions).toHaveLength(2);

    const secondPass = buildReplacementSuggestions(
      doc,
      [spec({ id: "op-1-again", literalText: "Acme Inc." })],
      { occupiedRanges: firstPass.suggestions.map((s) => s.range) },
    );
    expect(secondPass.suggestions).toHaveLength(0);
    expect(secondPass.placedSpecIds.size).toBe(0);
  });
});

describe("extractCompletedStreamingOperations", () => {
  const completeOp: DocxEditOperation = {
    type: "replaceInBlock",
    blockId: "B1",
    find: "Acme",
    replace: "{{seller.name}}",
    severity: "low",
    area: "Names",
  };

  test("returns every element except the trailing (possibly partial) one", () => {
    const operations = extractCompletedStreamingOperations({
      operations: [
        completeOp,
        { ...completeOp, blockId: "B2" },
        { type: "replaceInBlock", blockId: "B3", find: "Bet" },
      ],
    });
    expect(operations).toHaveLength(2);
    const second = operations.at(1);
    // Narrow on the discriminator: range-addressed ops carry no blockId.
    expect(second?.type === "replaceInBlock" ? second.blockId : null).toBe(
      "B2",
    );
  });

  test("stops at the first malformed element to keep indices aligned", () => {
    const operations = extractCompletedStreamingOperations({
      operations: [
        { type: "replaceInBlock", blockId: "B1" },
        completeOp,
        { trailing: true },
      ],
    });
    expect(operations).toHaveLength(0);
  });

  test("non-object input and missing operations yield nothing", () => {
    expect(extractCompletedStreamingOperations(undefined)).toEqual([]);
    expect(extractCompletedStreamingOperations("{")).toEqual([]);
    expect(extractCompletedStreamingOperations({})).toEqual([]);
    expect(extractCompletedStreamingOperations({ operations: "x" })).toEqual(
      [],
    );
    expect(extractCompletedStreamingOperations({ operations: [] })).toEqual([]);
  });
});

describe("operationFingerprint", () => {
  test("is key-order insensitive and value sensitive", () => {
    const streamed: DocxEditOperation = {
      type: "replaceInBlock",
      blockId: "B1",
      find: "Acme",
      replace: "{{seller.name}}",
      severity: "low",
      area: "Names",
    };
    const finalized: DocxEditOperation = {
      area: "Names",
      severity: "low",
      replace: "{{seller.name}}",
      find: "Acme",
      blockId: "B1",
      type: "replaceInBlock",
    };
    expect(operationFingerprint(streamed)).toBe(
      operationFingerprint(finalized),
    );
    expect(operationFingerprint({ ...streamed, replace: "other" })).not.toBe(
      operationFingerprint(finalized),
    );
  });

  test("a streamed operation (no id) fingerprints the same as its folio-parsed counterpart (minted id)", () => {
    // Genuine streamed-ingestion path: `extractCompletedStreamingOperations`
    // never mints an `id` — folio's own parser does that once the call
    // input is complete. The two representations of the same edit must
    // still de-duplicate against each other, so the fingerprint must
    // ignore `id`.
    const [streamed] = extractCompletedStreamingOperations({
      operations: [
        {
          type: "replaceInBlock",
          blockId: "B1",
          find: "Acme",
          replace: "{{seller.name}}",
          severity: "low",
          area: "Names",
        },
        // Trailing element makes the first one "completed".
        { type: "replaceInBlock", blockId: "B2" },
      ],
    });
    if (!streamed) {
      throw new Error("expected a streamed operation");
    }
    expect(streamed.id).toBeUndefined();

    const parsed: DocxEditOperation = { ...streamed, id: "minted-op-id" };

    expect(operationFingerprint(streamed)).toBe(operationFingerprint(parsed));
  });

  test("a streamed plain-string comment fingerprints the same as folio's wrapped comment", () => {
    // The tool contract lets the model write `comment` as a string; folio's
    // parser wraps it into `{ text }`. The streamed side must wrap too, or
    // every commented op would be re-placed after the parse.
    const [streamed] = extractCompletedStreamingOperations({
      operations: [
        {
          type: "deleteBlock",
          blockId: "B1",
          comment: "Duplicate clause",
          severity: "medium",
          area: "Wording",
        },
        { type: "deleteBlock", blockId: "B2" },
      ],
    });
    if (!streamed) {
      throw new Error("expected a streamed operation");
    }
    expect(streamed.comment).toEqual({ text: "Duplicate clause" });

    const parsed: DocxEditOperation = {
      id: "minted-op-id",
      type: "deleteBlock",
      blockId: "B1",
      comment: { text: "Duplicate clause" },
      severity: "medium",
      area: "Wording",
    };
    expect(operationFingerprint(streamed)).toBe(operationFingerprint(parsed));
  });
});

describe("extractFieldMarkerPath", () => {
  test("accepts exactly one value marker (whitespace tolerated)", () => {
    expect(extractFieldMarkerPath("{{company.name}}")).toBe("company.name");
    expect(extractFieldMarkerPath("  {{ signing_date }}  ")).toBe(
      "signing_date",
    );
    expect(extractFieldMarkerPath("{{ fee | number | min(0) }}")).toBe("fee");
  });

  test("rejects non-marker replacements, tags, and invalid paths", () => {
    expect(extractFieldMarkerPath("Example Ltd.")).toBeNull();
    expect(extractFieldMarkerPath("{{a}} and {{b}}")).toBeNull();
    expect(extractFieldMarkerPath("{{attorneys[0].name}}")).toBeNull();
    expect(extractFieldMarkerPath("{% if condition %}")).toBeNull();
    expect(extractFieldMarkerPath('{{ clause("Liability") }}')).toBeNull();
    expect(extractFieldMarkerPath("{{ loop.index }}")).toBeNull();
  });
});
