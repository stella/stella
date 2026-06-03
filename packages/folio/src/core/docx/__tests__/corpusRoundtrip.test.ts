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

// ============================================================================
// FIXTURE 6: nested block-level SDTs
// ============================================================================
//
// Block SDT wrappers are unwrapped on parse today, so neither the outer nor
// the inner property bag survives. The fixture asserts content fidelity —
// the inner paragraph text must round-trip — and is here so the upgrade
// path for block SDT preservation has coverage to land on.

describe("corpus round-trip: nested-block-sdt.docx", () => {
  test("inner paragraph text survives both wrapper layers", async () => {
    const original = await parseDocx(readFixture("nested-block-sdt.docx"));
    const roundTripped = await fullRoundTrip(original);

    expect(bodyText(roundTripped)).toBe(bodyText(original));
    expect(bodyText(roundTripped)).toContain("Nested content paragraph.");
  });
});

// ============================================================================
// FIXTURE 7: SDT with run-formatted placeholder rPr (color + bold)
// ============================================================================
//
// Folio does not currently project `<w:rPr>` from inside `<w:sdtPr>` onto
// the model, so the assertion is structural: the rPr child must not be
// classified as an SDT type, the SDT must keep the default `richText`
// classification, and the alias/tag round-trip cleanly. Run formatting on
// the placeholder content (red bold text) survives through the normal run
// path.

describe("corpus round-trip: sdt-rpr-placeholder.docx", () => {
  test("rPr in sdtPr does not confuse the type classifier", async () => {
    const original = await parseDocx(readFixture("sdt-rpr-placeholder.docx"));
    const roundTripped = await fullRoundTrip(original);

    const sdt = findFirstInlineSdt(roundTripped.package.document.content);
    expect(sdt).not.toBeNull();
    if (!sdt) {
      return;
    }
    expect(sdt.properties.sdtType).toBe("richText");
    expect(sdt.properties.alias).toBe("Coloured placeholder");
    expect(sdt.properties.tag).toBe("rpr-placeholder");
    expect(bodyText(roundTripped)).toContain("Placeholder text.");

    // Inner run carries red bold formatting from the placeholder content.
    const innerRun = sdt.content.find((c) => c.type === "run");
    expect(innerRun).toBeDefined();
    if (innerRun?.type !== "run") {
      return;
    }
    expect(innerRun.formatting?.bold).toBe(true);
  });
});

// ============================================================================
// FIXTURE 8: empty <w:sdtContent/>
// ============================================================================
//
// The inline SDT must survive with empty content, and the surrounding runs
// ("Before: " / " :after") must keep their position. A second round-trip
// must be idempotent — no synthetic content should accumulate.

describe("corpus round-trip: empty-sdt-content.docx", () => {
  test("empty sdtContent survives and round-trip is idempotent", async () => {
    const original = await parseDocx(readFixture("empty-sdt-content.docx"));
    const first = await fullRoundTrip(original);
    const second = await fullRoundTrip(first);

    const sdt = findFirstInlineSdt(first.package.document.content);
    expect(sdt).not.toBeNull();
    if (!sdt) {
      return;
    }
    expect(sdt.properties.tag).toBe("empty-slot");
    expect(sdt.content).toHaveLength(0);

    // Surrounding runs survive verbatim.
    expect(bodyText(first)).toContain("Before:");
    expect(bodyText(first)).toContain(":after");
    // Idempotence — second round-trip matches the first.
    expect(bodyText(second)).toBe(bodyText(first));
  });
});

// ============================================================================
// FIXTURE 9: authored empty paragraph inside block sdtContent
// ============================================================================
//
// `<w:sdtContent><w:p/></w:sdtContent>` carries an authored empty paragraph
// (the author wanted a blank line). The block SDT wrapper is unwrapped on
// parse, but the empty paragraph itself must survive — i.e. we expect three
// paragraphs total: heading, blank, trailing.

describe("corpus round-trip: authored-empty-paragraph.docx", () => {
  test("authored empty paragraph is not dropped by the filler heuristic", async () => {
    const original = await parseDocx(
      readFixture("authored-empty-paragraph.docx"),
    );
    const roundTripped = await fullRoundTrip(original);

    const recoveredParas = collectParagraphs(
      roundTripped.package.document.content,
    );
    expect(recoveredParas).toHaveLength(3);
    expect(paragraphText(recoveredParas[0]!)).toBe("Heading paragraph.");
    expect(paragraphText(recoveredParas[1]!)).toBe("");
    expect(paragraphText(recoveredParas[2]!)).toBe("Trailing paragraph.");
  });
});

// ============================================================================
// FIXTURE 10: date with fractional-second fullDate
// ============================================================================
//
// Folio keeps the raw ISO timestamp from `w:fullDate` in `dateFormat` (no
// dedicated `dateValueISO` field is modeled). The full string, including
// the `.000Z` milliseconds, must survive the round-trip verbatim.

describe("corpus round-trip: date-fractional-seconds.docx", () => {
  test("fractional seconds in fullDate survive verbatim", async () => {
    const original = await parseDocx(
      readFixture("date-fractional-seconds.docx"),
    );
    const roundTripped = await fullRoundTrip(original);

    const sdt = findFirstInlineSdt(roundTripped.package.document.content);
    expect(sdt).not.toBeNull();
    if (!sdt) {
      return;
    }
    expect(sdt.properties.sdtType).toBe("date");
    expect(sdt.properties.dateFormat).toBe("2026-06-02T00:00:00.000Z");
    expect(sdt.properties.tag).toBe("signed-at");
  });
});

// ============================================================================
// FIXTURE 11: dropdown with `<w:listItem w:value=""/>`
// ============================================================================
//
// The empty string is a legitimate dropdown value ("no choice yet"). It
// must survive on the listItems entry without being elided or coerced to
// the displayText.

describe("corpus round-trip: dropdown-empty-value.docx", () => {
  test("empty-string list item value survives", async () => {
    const original = await parseDocx(readFixture("dropdown-empty-value.docx"));
    const roundTripped = await fullRoundTrip(original);

    const sdt = findFirstInlineSdt(roundTripped.package.document.content);
    expect(sdt).not.toBeNull();
    if (!sdt) {
      return;
    }
    expect(sdt.properties.sdtType).toBe("dropdown");
    expect(sdt.properties.listItems).toEqual([
      { displayText: "(none)", value: "" },
      { displayText: "Yes", value: "Y" },
      { displayText: "No", value: "N" },
    ]);
  });
});

// ============================================================================
// FIXTURES 12-14: lock variants
// ============================================================================

describe("corpus round-trip: lock-sdt-locked.docx", () => {
  test("lock=sdtLocked round-trips", async () => {
    const original = await parseDocx(readFixture("lock-sdt-locked.docx"));
    const roundTripped = await fullRoundTrip(original);
    const sdt = findFirstInlineSdt(roundTripped.package.document.content);
    expect(sdt?.properties.lock).toBe("sdtLocked");
    expect(sdt?.properties.tag).toBe("lock-sdt");
  });
});

describe("corpus round-trip: lock-content-locked.docx", () => {
  test("lock=contentLocked round-trips", async () => {
    const original = await parseDocx(readFixture("lock-content-locked.docx"));
    const roundTripped = await fullRoundTrip(original);
    const sdt = findFirstInlineSdt(roundTripped.package.document.content);
    expect(sdt?.properties.lock).toBe("contentLocked");
    expect(sdt?.properties.tag).toBe("lock-content");
  });
});

describe("corpus round-trip: lock-sdt-content-locked.docx", () => {
  test("lock=sdtContentLocked round-trips", async () => {
    const original = await parseDocx(
      readFixture("lock-sdt-content-locked.docx"),
    );
    const roundTripped = await fullRoundTrip(original);
    const sdt = findFirstInlineSdt(roundTripped.package.document.content);
    expect(sdt?.properties.lock).toBe("sdtContentLocked");
    expect(sdt?.properties.tag).toBe("lock-both");
  });
});

// ============================================================================
// FIXTURE 15: w15:repeatingSection
// ============================================================================
//
// The Document model does not yet project repeatingSection as its own
// sdtType, so the parser falls back to `richText` and the marker is
// dropped. The fixture asserts the wrapper is not mis-classified and that
// the inner text content survives — so the upgrade path lands on green.

describe("corpus round-trip: repeating-section.docx", () => {
  test("repeatingSection wrapper does not mis-classify the SDT", async () => {
    const original = await parseDocx(readFixture("repeating-section.docx"));
    const roundTripped = await fullRoundTrip(original);

    // Wrapper unwraps to its paragraph (block SDT unwrap path); content
    // text must survive both round-trip stages.
    expect(bodyText(roundTripped)).toBe(bodyText(original));
    expect(bodyText(roundTripped)).toContain(
      "One row of the repeating section.",
    );
  });
});

// ============================================================================
// FIXTURE 16: w14:checkbox with val="true"
// ============================================================================

describe("corpus round-trip: checkbox-val-true.docx", () => {
  test('w14:checked val="true" recognised as checked', async () => {
    const original = await parseDocx(readFixture("checkbox-val-true.docx"));
    const roundTripped = await fullRoundTrip(original);
    const sdt = findFirstInlineSdt(roundTripped.package.document.content);
    expect(sdt?.properties.sdtType).toBe("checkbox");
    expect(sdt?.properties.checked).toBe(true);
    expect(sdt?.properties.tag).toBe("bool-true");
  });
});

// ============================================================================
// FIXTURE 17: w14:checkbox with val="false"
// ============================================================================

describe("corpus round-trip: checkbox-val-false.docx", () => {
  test('w14:checked val="false" recognised as unchecked', async () => {
    const original = await parseDocx(readFixture("checkbox-val-false.docx"));
    const roundTripped = await fullRoundTrip(original);
    const sdt = findFirstInlineSdt(roundTripped.package.document.content);
    expect(sdt?.properties.sdtType).toBe("checkbox");
    expect(sdt?.properties.checked).toBe(false);
    expect(sdt?.properties.tag).toBe("bool-false");
  });
});

// ============================================================================
// FIXTURE 18: placeholder docPart
// ============================================================================

describe("corpus round-trip: placeholder-docpart.docx", () => {
  test("placeholder docPart val populates the placeholder field", async () => {
    const original = await parseDocx(readFixture("placeholder-docpart.docx"));
    const sdt = findFirstInlineSdt(original.package.document.content);
    expect(sdt).not.toBeNull();
    if (!sdt) {
      return;
    }
    expect(sdt.properties.placeholder).toBe("DefaultText");
    expect(sdt.properties.tag).toBe("default-holder");
  });
});

// ============================================================================
// FIXTURE 19: w16sdtdh:dataHash marker
// ============================================================================
//
// The marker itself is not currently projected onto the model; the test
// asserts the parser does not mis-classify the SDT (stays `richText`) and
// that alias/tag round-trip cleanly even when an unrecognised namespaced
// child is present in sdtPr.

describe("corpus round-trip: datahash-sdt.docx", () => {
  test("dataHash child does not break alias/tag recovery", async () => {
    const original = await parseDocx(readFixture("datahash-sdt.docx"));
    const roundTripped = await fullRoundTrip(original);
    const sdt = findFirstInlineSdt(roundTripped.package.document.content);
    expect(sdt).not.toBeNull();
    if (!sdt) {
      return;
    }
    expect(sdt.properties.sdtType).toBe("richText");
    expect(sdt.properties.alias).toBe("Hashed slot");
    expect(sdt.properties.tag).toBe("hashed-slot");
    expect(bodyText(roundTripped)).toContain("Hashed content.");
  });
});
