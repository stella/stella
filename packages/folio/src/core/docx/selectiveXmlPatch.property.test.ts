/**
 * Property tests for `buildPatchedDocumentXml` and helpers.
 *
 * The selective patcher mutates raw OOXML strings. We use fast-check to fuzz
 * the structural invariants that the patcher must preserve regardless of the
 * actual paragraph content:
 *
 *   1. An empty change set is the identity.
 *   2. Patching with the same serialized XML is the identity.
 *   3. Patching one paragraph only mutates that paragraph's slice.
 *   4. Patch order does not matter (the user-visible result must not depend
 *      on Set iteration order).
 *   5. Paragraph count must be invariant across patch.
 *   6. `findParagraphOffsets` returns a well-formed span.
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";

import {
  buildPatchedDocumentXml,
  countParagraphElements,
  findParagraphOffsets,
} from "./selectiveXmlPatch";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const paraIdArb = fc
  .stringMatching(/^[A-Z]{3}[0-9]{4}$/u)
  .map((id) => id.toUpperCase());

const paraTextArb = fc.stringMatching(/^[A-Za-z0-9 ]{1,40}$/u);

type Para = { id: string; text: string };

const paragraphsArb: fc.Arbitrary<Para[]> = fc.uniqueArray(
  fc.record({ id: paraIdArb, text: paraTextArb }),
  {
    selector: (p) => p.id,
    minLength: 2,
    maxLength: 8,
  },
);

function renderParagraph(p: Para): string {
  return `<w:p w14:paraId="${p.id}"><w:r><w:t>${p.text}</w:t></w:r></w:p>`;
}

function renderDoc(paras: Para[]): string {
  return `${XML_DECL}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
<w:body>
${paras.map(renderParagraph).join("\n")}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body>
</w:document>`;
}

describe("buildPatchedDocumentXml property invariants", () => {
  test("empty change set returns the original XML unchanged", () => {
    fc.assert(
      fc.property(paragraphsArb, (paras) => {
        const xml = renderDoc(paras);
        const result = buildPatchedDocumentXml(xml, xml, new Set());
        expect(result).toBe(xml);
      }),
      { numRuns: 50 },
    );
  });

  test("patching against identical serialized XML is the identity", () => {
    fc.assert(
      fc.property(paragraphsArb, (paras) => {
        const xml = renderDoc(paras);
        const ids = new Set(paras.map((p) => p.id));
        const result = buildPatchedDocumentXml(xml, xml, ids);
        expect(result).toBe(xml);
      }),
      { numRuns: 50 },
    );
  });

  test("paragraph count is preserved after a patch", () => {
    fc.assert(
      fc.property(paragraphsArb, fc.integer({ min: 0 }), (paras, seed) => {
        const idx = seed % paras.length;
        const original = renderDoc(paras);
        const edited = paras.map((p, i) =>
          i === idx ? { ...p, text: `${p.text}_NEW` } : p,
        );
        const serialized = renderDoc(edited);
        const ids = new Set([edited[idx]!.id]);
        const result = buildPatchedDocumentXml(original, serialized, ids);
        expect(result).not.toBeNull();
        if (result) {
          expect(countParagraphElements(result)).toBe(
            countParagraphElements(original),
          );
        }
      }),
      { numRuns: 50 },
    );
  });

  test("bytes outside the changed paragraph remain byte-identical", () => {
    fc.assert(
      fc.property(paragraphsArb, fc.integer({ min: 0 }), (paras, seed) => {
        const idx = seed % paras.length;
        const target = paras[idx]!;
        const original = renderDoc(paras);
        const edited = paras.map((p, i) =>
          i === idx ? { ...p, text: `${p.text}_X` } : p,
        );
        const serialized = renderDoc(edited);
        const result = buildPatchedDocumentXml(
          original,
          serialized,
          new Set([target.id]),
        );
        if (!result) {
          return;
        }

        const originalOffsets = findParagraphOffsets(original, target.id);
        const resultOffsets = findParagraphOffsets(result, target.id);
        expect(originalOffsets).not.toBeNull();
        expect(resultOffsets).not.toBeNull();
        if (originalOffsets && resultOffsets) {
          expect(result.slice(0, resultOffsets.start)).toBe(
            original.slice(0, originalOffsets.start),
          );
          expect(result.slice(resultOffsets.end)).toBe(
            original.slice(originalOffsets.end),
          );
        }
      }),
      { numRuns: 50 },
    );
  });

  test("patch result is independent of Set iteration order over changed ids", () => {
    fc.assert(
      fc.property(paragraphsArb, (paras) => {
        if (paras.length < 2) {
          return;
        }
        const original = renderDoc(paras);
        const edited = paras.map((p, i) =>
          i < 2 ? { ...p, text: `${p.text}_X` } : p,
        );
        const serialized = renderDoc(edited);

        const orderA = new Set([paras[0]!.id, paras[1]!.id]);
        const orderB = new Set([paras[1]!.id, paras[0]!.id]);
        const a = buildPatchedDocumentXml(original, serialized, orderA);
        const b = buildPatchedDocumentXml(original, serialized, orderB);
        expect(a).toBe(b);
      }),
      { numRuns: 50 },
    );
  });

  test("findParagraphOffsets returns a well-formed span", () => {
    fc.assert(
      fc.property(paragraphsArb, (paras) => {
        const xml = renderDoc(paras);
        for (const p of paras) {
          const offsets = findParagraphOffsets(xml, p.id);
          expect(offsets).not.toBeNull();
          if (offsets) {
            expect(offsets.end).toBeGreaterThan(offsets.start);
            const slice = xml.slice(offsets.start, offsets.end);
            expect(slice.startsWith("<w:p")).toBe(true);
            expect(slice.endsWith("</w:p>")).toBe(true);
          }
        }
      }),
      { numRuns: 50 },
    );
  });
});
