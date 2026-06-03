/**
 * Corpus round-trip tests for a small bundle of hand-written DOCX fixtures.
 *
 * Each fixture exercises a different OOXML shape (block SDTs, inline SDTs,
 * dropdowns, checkboxes, mixed run properties, alt-prefix namespace bindings).
 * For each one we run the full editor pipeline:
 *
 *   parseDocx → toProseDoc → fromProseDoc → repackDocx → parseDocx
 *
 * and assert that the recovered structural shape — paragraph counts, text
 * content, and SDT-specific data — matches the original parse.
 *
 * Fixture provenance and licensing: see
 * `__fixtures__/corpus/PROVENANCE.md`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fromProseDoc } from "../../prosemirror/conversion/fromProseDoc";
import { toProseDoc } from "../../prosemirror/conversion/toProseDoc";
import type {
  BlockContent,
  Document,
  InlineSdt,
  Paragraph,
  ParagraphContent,
} from "../../types/document";
import { parseDocx } from "../parser";
import { repackDocx } from "../rezip";

const FIXTURES_DIR = join(import.meta.dir, "__fixtures__", "corpus");

const readFixture = (filename: string): ArrayBuffer => {
  const bytes = readFileSync(join(FIXTURES_DIR, filename));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
};

/**
 * Run the full round-trip pipeline.
 *
 * `toProseDoc → fromProseDoc` exercises the PM bridge; `repackDocx →
 * parseDocx` exercises the serializer and re-parses the resulting package.
 */
async function fullRoundTrip(original: Document): Promise<Document> {
  const pmDoc = toProseDoc(original);
  const back = fromProseDoc(pmDoc, original);
  const repacked = await repackDocx(back, { updateModifiedDate: false });
  return await parseDocx(repacked);
}

/** Collect every paragraph in the body, descending into BlockSdt wrappers. */
function collectParagraphs(blocks: readonly BlockContent[]): Paragraph[] {
  const out: Paragraph[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") {
      out.push(block);
    } else if (block.type === "blockSdt") {
      out.push(...collectParagraphs(block.content));
    }
  }
  return out;
}

/** Concatenate the text from a run/inlineSdt subtree. */
function textOfInline(node: ParagraphContent | InlineSdt): string {
  if (node.type === "run") {
    let s = "";
    for (const c of node.content) {
      if (c.type === "text") {
        s += c.text;
      }
    }
    return s;
  }
  if (node.type === "inlineSdt") {
    let s = "";
    for (const c of node.content) {
      s += textOfInline(c);
    }
    return s;
  }
  if (node.type === "hyperlink") {
    let s = "";
    for (const c of node.children) {
      if (c.type === "run") {
        s += textOfInline(c);
      }
    }
    return s;
  }
  return "";
}

function paragraphText(p: Paragraph): string {
  let s = "";
  for (const c of p.content) {
    s += textOfInline(c);
  }
  return s;
}

function bodyText(doc: Document): string {
  return collectParagraphs(doc.package.document.content)
    .map(paragraphText)
    .join("\n");
}

/** Find the first InlineSdt in the body, including nested ones. */
function findFirstInlineSdt(blocks: readonly BlockContent[]): InlineSdt | null {
  for (const para of collectParagraphs(blocks)) {
    const hit = findInlineSdtInParagraph(para);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function findInlineSdtInParagraph(p: Paragraph): InlineSdt | null {
  for (const c of p.content) {
    if (c.type === "inlineSdt") {
      return c;
    }
    if (c.type === "hyperlink") {
      // Hyperlinks don't carry SDTs in our corpus, but be defensive.
      for (const child of c.children) {
        if (child.type === "inlineSdt") {
          return child;
        }
      }
    }
  }
  return null;
}

// ============================================================================
// FIXTURE 1: block-level richText SDT
// ============================================================================
//
// The current parser unwraps `<w:sdt>` block wrappers (the SdtProperties are
// dropped at the BlockSdt boundary), so this test asserts content fidelity
// rather than property fidelity. Adding BlockSdt preservation is tracked
// separately; the fixture is here so the upgrade path has coverage to land on.

describe("corpus round-trip: block-sdt-richtext.docx", () => {
  test("paragraph count and visible text survive parse → PM → serialize", async () => {
    const original = await parseDocx(readFixture("block-sdt-richtext.docx"));
    const roundTripped = await fullRoundTrip(original);

    const originalParas = collectParagraphs(original.package.document.content);
    const recoveredParas = collectParagraphs(
      roundTripped.package.document.content,
    );

    expect(recoveredParas).toHaveLength(originalParas.length);
    expect(bodyText(roundTripped)).toBe(bodyText(original));
    // The wrapper text and the trailing paragraph must both survive.
    expect(bodyText(roundTripped)).toContain("Heads of Terms — Project Acorn");
    expect(bodyText(roundTripped)).toContain("Trailing paragraph.");
  });
});

// ============================================================================
// FIXTURE 2: inline SDT with a dropdown list
// ============================================================================

describe("corpus round-trip: inline-sdt-dropdown.docx", () => {
  test("dropdown SDT alias/tag/listItems round-trip", async () => {
    const original = await parseDocx(readFixture("inline-sdt-dropdown.docx"));
    const roundTripped = await fullRoundTrip(original);

    const sdt = findFirstInlineSdt(roundTripped.package.document.content);
    expect(sdt).not.toBeNull();
    if (!sdt) {
      return;
    }

    expect(sdt.properties.sdtType).toBe("dropdown");
    expect(sdt.properties.alias).toBe("Governing law");
    expect(sdt.properties.tag).toBe("governing-law");
    expect(sdt.properties.listItems).toEqual([
      { displayText: "England and Wales", value: "EW" },
      { displayText: "Czech Republic", value: "CZ" },
      { displayText: "Slovakia", value: "SK" },
    ]);
    expect(bodyText(roundTripped)).toBe(bodyText(original));
  });
});

// ============================================================================
// FIXTURE 3: inline SDT with a w14:checkbox
// ============================================================================

describe("corpus round-trip: inline-sdt-checkbox.docx", () => {
  test("checkbox SDT tag/checked state round-trip", async () => {
    const original = await parseDocx(readFixture("inline-sdt-checkbox.docx"));
    const roundTripped = await fullRoundTrip(original);

    const sdt = findFirstInlineSdt(roundTripped.package.document.content);
    expect(sdt).not.toBeNull();
    if (!sdt) {
      return;
    }

    expect(sdt.properties.sdtType).toBe("checkbox");
    expect(sdt.properties.alias).toBe("NDA accepted");
    expect(sdt.properties.tag).toBe("nda-accepted");
    expect(sdt.properties.checked).toBe(true);
    expect(bodyText(roundTripped)).toContain("I accept the NDA.");
  });
});

// ============================================================================
// FIXTURE 4: nested inline SDTs with mixed run properties (bold/italic)
// ============================================================================

describe("corpus round-trip: inline-sdt-mixed-rpr.docx", () => {
  test("outer SDT lock and nested SDT tag both round-trip", async () => {
    const original = await parseDocx(readFixture("inline-sdt-mixed-rpr.docx"));
    const roundTripped = await fullRoundTrip(original);

    const outer = findFirstInlineSdt(roundTripped.package.document.content);
    expect(outer).not.toBeNull();
    if (!outer) {
      return;
    }

    expect(outer.properties.tag).toBe("party-block");
    expect(outer.properties.lock).toBe("sdtLocked");

    // Inner SDT lives in the outer's content list.
    const inner = outer.content.find(
      (c): c is InlineSdt => c.type === "inlineSdt",
    );
    expect(inner).toBeDefined();
    if (!inner) {
      return;
    }
    expect(inner.properties.tag).toBe("buyer-name");

    // Bold "Buyer: " and italic "ACME, s.r.o." both survive as runs with
    // formatting inside the SDT placeholder.
    const innerRun = inner.content.find((c) => c.type === "run");
    expect(innerRun).toBeDefined();
    if (innerRun?.type !== "run") {
      return;
    }
    expect(innerRun.formatting?.italic).toBe(true);

    expect(bodyText(roundTripped)).toBe(bodyText(original));
  });
});

// ============================================================================
// FIXTURE 5: alt-prefix namespace declarations (`x:` instead of `w:`)
// ============================================================================
//
// The serializer canonicalises namespace prefixes, so the literal `x:` in
// the source XML disappears on save — that part is expected normalisation
// and intentionally excluded from the diff. What still has to survive is
// the structural shape (paragraph + inline SDT) and the SDT discriminator
// the parser can recover from local names alone.

describe("corpus round-trip: alt-prefix-sdt.docx", () => {
  test("structure and SDT type survive even with non-w prefix in source", async () => {
    const original = await parseDocx(readFixture("alt-prefix-sdt.docx"));
    const roundTripped = await fullRoundTrip(original);

    expect(bodyText(roundTripped)).toContain("Due date:");
    expect(bodyText(roundTripped)).toContain("31 December 2026");

    const sdt = findFirstInlineSdt(roundTripped.package.document.content);
    expect(sdt).not.toBeNull();
    if (!sdt) {
      return;
    }
    // sdtType is derived from a child local name (`date`), so it must
    // round-trip even when the source used a non-default prefix.
    expect(sdt.properties.sdtType).toBe("date");
    // alias/tag come from `x:val`-style attributes in the source; the
    // attribute reader has to fall back to local-name matching for these
    // to survive a parse → serialize → parse round-trip.
    expect(sdt.properties.alias).toBe("Due date");
    expect(sdt.properties.tag).toBe("due-date");
  });
});
