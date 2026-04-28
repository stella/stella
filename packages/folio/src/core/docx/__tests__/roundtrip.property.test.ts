/**
 * Property-based round-trip tests for DOCX serialization.
 *
 * Generates random ProseMirror documents via fast-check arbitraries,
 * converts them through the full pipeline:
 *
 *   PM Doc → fromProseDoc → Document → serializeDocument → XML
 *   XML → parseDocumentBody → Document → toProseDoc → PM Doc
 *
 * Then asserts that the original and round-tripped documents are
 * structurally equivalent (after normalization).
 *
 * Usage:
 *   bun test src/core/docx/__tests__/roundtrip.property.test.ts
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import type { Node as PMNode, Mark } from "prosemirror-model";

import { fromProseDoc } from "../../prosemirror/conversion/fromProseDoc";
import { toProseDoc } from "../../prosemirror/conversion/toProseDoc";
import { schema } from "../../prosemirror/schema";
import { parseDocumentBody } from "../documentParser";
import { serializeDocument } from "../serializer/documentSerializer";

// ============================================================================
// ARBITRARIES — generators for random ProseMirror content
// ============================================================================

/** Safe text: printable ASCII, no control characters or XML-special chars */
const safeText = fc.string({ minLength: 1, maxLength: 80 }).filter(isSafeText);

function isSafeText(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }

  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || char === "<" || char === ">" || char === "&") {
      return false;
    }
  }

  return true;
}

/** Generate a subset of marks to apply to a text run */
function arbMarks(): fc.Arbitrary<Mark[]> {
  return fc.subarray(
    [
      schema.marks.bold.create(),
      schema.marks.italic.create(),
      schema.marks.underline.create({ lineType: "single" }),
      schema.marks.strike.create(),
    ],
    { minLength: 0, maxLength: 3 },
  );
}

/** Generate a text node with random marks */
function arbTextNode(): fc.Arbitrary<PMNode> {
  return fc
    .tuple(safeText, arbMarks())
    .map(([text, marks]) => schema.text(text, marks));
}

/** Generate a paragraph with random inline content */
function arbParagraph(): fc.Arbitrary<PMNode> {
  return fc
    .array(arbTextNode(), { minLength: 0, maxLength: 8 })
    .map((inlines) => {
      // Empty paragraphs are valid in DOCX
      if (inlines.length === 0) {
        return schema.nodes.paragraph.create();
      }
      return schema.nodes.paragraph.create(null, inlines);
    });
}

/** Generate a paragraph with formatting attributes */
function arbFormattedParagraph(): fc.Arbitrary<PMNode> {
  return fc
    .tuple(
      arbParagraph(),
      fc.constantFrom(undefined, "left", "center", "right", "both"),
      fc.option(fc.integer({ min: 0, max: 720 }), { nil: undefined }), // spaceBefore (twips)
      fc.option(fc.integer({ min: 0, max: 720 }), { nil: undefined }), // spaceAfter (twips)
    )
    .map(([para, alignment, spaceBefore, spaceAfter]) => {
      const attrs: Record<string, unknown> = {};
      if (alignment) {
        attrs.alignment = alignment;
      }
      if (spaceBefore !== undefined) {
        attrs.spaceBefore = spaceBefore;
      }
      if (spaceAfter !== undefined) {
        attrs.spaceAfter = spaceAfter;
      }
      // Rebuild paragraph with attrs
      const content: PMNode[] = [];
      // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
      para.forEach((child) => content.push(child));
      return schema.nodes.paragraph.create(attrs, content);
    });
}

/** Generate a table cell with 1-3 paragraphs */
function arbTableCell(): fc.Arbitrary<PMNode> {
  return fc
    .array(arbParagraph(), { minLength: 1, maxLength: 3 })
    .map((paras) => schema.nodes.tableCell.create(null, paras));
}

/** Generate a table row with 1-4 cells */
function arbTableRow(): fc.Arbitrary<PMNode> {
  return fc
    .array(arbTableCell(), { minLength: 1, maxLength: 4 })
    .map((cells) => schema.nodes.tableRow.create(null, cells));
}

/** Generate a simple table with 1-4 rows */
function arbTable(): fc.Arbitrary<PMNode> {
  return fc
    .array(arbTableRow(), { minLength: 1, maxLength: 4 })
    .map((rows) => schema.nodes.table.create(null, rows));
}

/** Generate a text node with a tracked change mark (insertion or deletion) */
function arbTrackedChangeNode(): fc.Arbitrary<PMNode> {
  return fc
    .tuple(
      safeText,
      fc.constantFrom("insertion", "deletion"),
      fc.constantFrom("User A", "User B", "Reviewer"),
    )
    .map(([text, type, author]) => {
      const markType =
        type === "insertion" ? schema.marks.insertion : schema.marks.deletion;
      return schema.text(text, [
        markType.create({
          author,
          date: "2024-01-15T10:00:00Z",
          revisionId: 1,
        }),
      ]);
    });
}

/** Generate a paragraph with tracked changes */
function arbTrackedChangeParagraph(): fc.Arbitrary<PMNode> {
  return fc
    .array(fc.oneof(arbTextNode(), arbTrackedChangeNode()), {
      minLength: 1,
      maxLength: 6,
    })
    .map((inlines) => schema.nodes.paragraph.create(null, inlines));
}

/** Generate a block: paragraph or table */
function arbBlock(): fc.Arbitrary<PMNode> {
  return fc.oneof(
    { weight: 8, arbitrary: arbFormattedParagraph() },
    { weight: 2, arbitrary: arbTable() },
  );
}

/** Generate a full ProseMirror document */
function arbDocument(): fc.Arbitrary<PMNode> {
  return fc
    .array(arbBlock(), { minLength: 1, maxLength: 15 })
    .map((blocks) => schema.nodes.doc.create(null, blocks));
}

/** Generate a document with tracked changes */
function arbTrackedChangeDocument(): fc.Arbitrary<PMNode> {
  return fc
    .array(fc.oneof(arbTrackedChangeParagraph(), arbParagraph()), {
      minLength: 1,
      maxLength: 10,
    })
    .map((blocks) => schema.nodes.doc.create(null, blocks));
}

// ============================================================================
// NORMALIZATION — strip noise that doesn't affect content fidelity
// ============================================================================

type NormalizedNode = {
  type: string;
  text?: string;
  marks?: string[];
  attrs?: Record<string, unknown>;
  content?: NormalizedNode[];
};

/**
 * Normalize a PM document for comparison.
 * Strips rsid attributes, sorts marks alphabetically, removes
 * default/empty values that the serializer may add or drop.
 */
function normalizeDoc(doc: PMNode): NormalizedNode {
  return normalizeNode(doc);
}

function normalizeNode(node: PMNode): NormalizedNode {
  const result: NormalizedNode = { type: node.type.name };

  if (node.isText && node.text) {
    result.text = node.text;
  }

  // Sort marks by type name for order-independent comparison.
  // Filter out marks where all attributes are null/default (e.g.,
  // characterSpacing with all-null attrs added by the parser).
  const meaningfulMarks = node.marks.filter((m) => {
    const spec = m.type.spec.attrs;
    if (!spec) {
      return true;
    } // marks without attrs are always meaningful
    return Object.keys(spec).some((key) => {
      const defaultVal = spec[key]?.default;
      return m.attrs[key] !== defaultVal;
    });
  });
  if (meaningfulMarks.length > 0) {
    result.marks = meaningfulMarks.map((m) => m.type.name).sort();
  }

  // Include non-default attrs
  if (node.type.name === "paragraph") {
    const attrs: Record<string, unknown> = {};
    if (node.attrs.alignment) {
      attrs.alignment = node.attrs.alignment;
    }
    if (node.attrs.spaceBefore) {
      attrs.spaceBefore = node.attrs.spaceBefore;
    }
    if (node.attrs.spaceAfter && node.attrs.spaceAfter !== 160) {
      attrs.spaceAfter = node.attrs.spaceAfter;
    }
    if (Object.keys(attrs).length > 0) {
      result.attrs = attrs;
    }
  }

  // Recurse into children
  if (node.childCount > 0) {
    result.content = [];
    node.forEach((child) => {
      result.content!.push(normalizeNode(child));
    });
  }

  return result;
}

// ============================================================================
// ROUND-TRIP PIPELINE
// ============================================================================

/**
 * Full round-trip: PM Doc → Document → XML → Document → PM Doc
 */
function roundTrip(original: PMNode): PMNode {
  // Step 1: PM → Document model
  const doc = fromProseDoc(original);

  // Step 2: Document → XML string
  const xml = serializeDocument(doc);

  // Step 3: XML → Document model (parse just the body)
  const parsed = parseDocumentBody(xml);

  // Step 4: Document → PM
  const roundTripped = toProseDoc({ package: { document: parsed } } as never);

  return roundTripped;
}

// ============================================================================
// TESTS
// ============================================================================

describe("DOCX round-trip property tests", () => {
  test("serialization never crashes", () => {
    fc.assert(
      fc.property(arbDocument(), (doc) => {
        const docModel = fromProseDoc(doc);
        const xml = serializeDocument(docModel);
        expect(typeof xml).toBe("string");
        expect(xml.length).toBeGreaterThan(0);
      }),
      { numRuns: 500 },
    );
  });

  test("parsing never crashes", () => {
    fc.assert(
      fc.property(arbDocument(), (doc) => {
        const docModel = fromProseDoc(doc);
        const xml = serializeDocument(docModel);
        const parsed = parseDocumentBody(xml);
        expect(parsed.content.length).toBeGreaterThan(0);
      }),
      { numRuns: 500 },
    );
  });

  test("round-trip preserves document structure", () => {
    fc.assert(
      fc.property(arbDocument(), (doc) => {
        const result = roundTrip(doc);
        const originalNorm = normalizeDoc(doc);
        const resultNorm = normalizeDoc(result);
        expect(resultNorm).toEqual(originalNorm);
      }),
      { numRuns: 200 },
    );
  });

  test("round-trip preserves text content exactly", () => {
    fc.assert(
      fc.property(arbDocument(), (doc) => {
        const result = roundTrip(doc);
        // Extract all text from both documents
        const originalText = doc.textContent;
        const resultText = result.textContent;
        expect(resultText).toBe(originalText);
      }),
      { numRuns: 500 },
    );
  });

  test("round-trip preserves bold marks", () => {
    // Targeted test: paragraphs with bold text
    const boldDoc = fc
      .array(safeText, { minLength: 1, maxLength: 5 })
      .map((texts) => {
        const nodes = texts.map((t) =>
          schema.text(t, [schema.marks.bold.create()]),
        );
        return schema.nodes.doc.create(null, [
          schema.nodes.paragraph.create(null, nodes),
        ]);
      });

    fc.assert(
      fc.property(boldDoc, (doc) => {
        const result = roundTrip(doc);
        // Every text node should still be bold
        result.forEach((node) => {
          if (node.type.name === "paragraph") {
            node.forEach((child) => {
              if (child.isText && child.text?.trim()) {
                const hasBold = child.marks.some((m) => m.type.name === "bold");
                expect(hasBold).toBe(true);
              }
            });
          }
        });
      }),
      { numRuns: 200 },
    );
  });

  test("round-trip preserves italic marks", () => {
    const italicDoc = fc
      .array(safeText, { minLength: 1, maxLength: 5 })
      .map((texts) => {
        const nodes = texts.map((t) =>
          schema.text(t, [schema.marks.italic.create()]),
        );
        return schema.nodes.doc.create(null, [
          schema.nodes.paragraph.create(null, nodes),
        ]);
      });

    fc.assert(
      fc.property(italicDoc, (doc) => {
        const result = roundTrip(doc);
        result.forEach((node) => {
          if (node.type.name === "paragraph") {
            node.forEach((child) => {
              if (child.isText && child.text?.trim()) {
                const hasItalic = child.marks.some(
                  (m) => m.type.name === "italic",
                );
                expect(hasItalic).toBe(true);
              }
            });
          }
        });
      }),
      { numRuns: 200 },
    );
  });

  test("empty paragraphs survive round-trip", () => {
    const emptyParaDoc = fc.integer({ min: 1, max: 10 }).map((count) =>
      schema.nodes.doc.create(
        null,
        Array.from({ length: count }, () => schema.nodes.paragraph.create()),
      ),
    );

    fc.assert(
      fc.property(emptyParaDoc, (doc) => {
        const result = roundTrip(doc);
        expect(result.childCount).toBe(doc.childCount);
      }),
      { numRuns: 100 },
    );
  });

  test("alignment attribute survives round-trip", () => {
    const alignedDoc = fc
      .tuple(safeText, fc.constantFrom("left", "center", "right", "both"))
      .map(([text, alignment]) =>
        schema.nodes.doc.create(null, [
          schema.nodes.paragraph.create({ alignment }, [schema.text(text)]),
        ]),
      );

    fc.assert(
      fc.property(alignedDoc, (doc) => {
        const result = roundTrip(doc);
        const originalAlign = doc.firstChild?.attrs.alignment;
        const resultAlign = result.firstChild?.attrs.alignment;
        expect(resultAlign).toBe(originalAlign);
      }),
      { numRuns: 100 },
    );
  });

  test("tables survive round-trip", () => {
    const tableDoc = arbTable().map((table) =>
      schema.nodes.doc.create(null, [table]),
    );

    fc.assert(
      fc.property(tableDoc, (doc) => {
        const result = roundTrip(doc);
        // The document should contain a table
        let hasTable = false;
        result.forEach((node) => {
          if (node.type.name === "table") {
            hasTable = true;
          }
        });
        expect(hasTable).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  test("table text content preserved through round-trip", () => {
    const tableDoc = arbTable().map((table) =>
      schema.nodes.doc.create(null, [table]),
    );

    fc.assert(
      fc.property(tableDoc, (doc) => {
        const result = roundTrip(doc);
        expect(result.textContent).toBe(doc.textContent);
      }),
      { numRuns: 100 },
    );
  });

  test("documents with mixed paragraphs and tables round-trip", () => {
    fc.assert(
      fc.property(arbDocument(), (doc) => {
        const result = roundTrip(doc);
        expect(result.textContent).toBe(doc.textContent);
      }),
      { numRuns: 200 },
    );
  });

  test("tracked change marks survive round-trip", () => {
    fc.assert(
      fc.property(arbTrackedChangeDocument(), (doc) => {
        const result = roundTrip(doc);
        // Count tracked change marks in original
        let originalChanges = 0;
        doc.descendants((node) => {
          if (node.isText) {
            for (const mark of node.marks) {
              if (
                mark.type.name === "insertion" ||
                mark.type.name === "deletion"
              ) {
                originalChanges++;
              }
            }
          }
        });

        // Count tracked change marks in result
        let resultChanges = 0;
        result.descendants((node) => {
          if (node.isText) {
            for (const mark of node.marks) {
              if (
                mark.type.name === "insertion" ||
                mark.type.name === "deletion"
              ) {
                resultChanges++;
              }
            }
          }
        });

        // Same number of tracked changes
        expect(resultChanges).toBe(originalChanges);
      }),
      { numRuns: 200 },
    );
  });

  test("tracked change author preserved through round-trip", () => {
    fc.assert(
      fc.property(arbTrackedChangeDocument(), (doc) => {
        const result = roundTrip(doc);

        // Collect all authors from original
        const originalAuthors: string[] = [];
        doc.descendants((node) => {
          if (node.isText) {
            for (const mark of node.marks) {
              if (
                mark.type.name === "insertion" ||
                mark.type.name === "deletion"
              ) {
                originalAuthors.push(mark.attrs.author as string);
              }
            }
          }
        });

        // Collect all authors from result
        const resultAuthors: string[] = [];
        result.descendants((node) => {
          if (node.isText) {
            for (const mark of node.marks) {
              if (
                mark.type.name === "insertion" ||
                mark.type.name === "deletion"
              ) {
                resultAuthors.push(mark.attrs.author as string);
              }
            }
          }
        });

        expect(resultAuthors).toEqual(originalAuthors);
      }),
      { numRuns: 200 },
    );
  });

  test("multiple mark combinations survive round-trip", () => {
    // Generate text with 2-3 marks simultaneously
    const multiMarkDoc = fc
      .tuple(safeText, arbMarks())
      .filter(([, marks]) => marks.length >= 2)
      .map(([text, marks]) =>
        schema.nodes.doc.create(null, [
          schema.nodes.paragraph.create(null, [schema.text(text, marks)]),
        ]),
      );

    fc.assert(
      fc.property(multiMarkDoc, (doc) => {
        const result = roundTrip(doc);
        const originalNorm = normalizeDoc(doc);
        const resultNorm = normalizeDoc(result);
        expect(resultNorm).toEqual(originalNorm);
      }),
      { numRuns: 200 },
    );
  });
});
