/**
 * SDT inside a footnote/endnote body must round-trip as BlockSdt so
 * getContentControls + headless mutate APIs see citation slots and
 * bound metadata in notes the same way they see them in the main body.
 */

import { describe, expect, test } from "bun:test";

import {
  getEndnoteText,
  getFootnoteText,
  parseEndnotes,
  parseFootnotes,
} from "./footnoteParser";

const FOOTNOTE_WITH_SDT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="1">
    <w:p><w:r><w:t>before</w:t></w:r></w:p>
    <w:sdt>
      <w:sdtPr><w:tag w:val="cite"/><w:alias w:val="Citation"/></w:sdtPr>
      <w:sdtContent>
        <w:p><w:r><w:t>cited source</w:t></w:r></w:p>
      </w:sdtContent>
    </w:sdt>
    <w:p><w:r><w:t>after</w:t></w:r></w:p>
  </w:footnote>
</w:footnotes>`;

const ENDNOTE_WITH_SDT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:endnote w:id="2">
    <w:sdt>
      <w:sdtPr><w:tag w:val="bound"/><w:dataBinding w:xpath="/cite/source"/></w:sdtPr>
      <w:sdtContent>
        <w:p><w:r><w:t>bound endnote</w:t></w:r></w:p>
      </w:sdtContent>
    </w:sdt>
  </w:endnote>
</w:endnotes>`;

describe("footnote / endnote bodies preserve block-level w:sdt", () => {
  test("footnote with a block SDT recovers the BlockSdt in document order", () => {
    const map = parseFootnotes(FOOTNOTE_WITH_SDT);
    const footnote = map.byId.get(1);
    expect(footnote).toBeDefined();
    if (!footnote) {
      return;
    }
    expect(footnote.content.map((block) => block.type)).toEqual([
      "paragraph",
      "blockSdt",
      "paragraph",
    ]);
    const sdt = footnote.content[1];
    if (!sdt || sdt.type !== "blockSdt") {
      throw new TypeError("expected blockSdt at index 1");
    }
    expect(sdt.properties.tag).toBe("cite");
    expect(sdt.properties.alias).toBe("Citation");
    // Inner content is parsed, not frozen.
    expect(sdt.content[0]?.type).toBe("paragraph");
  });

  test("endnote with a bound SDT preserves the w:dataBinding in rawPropertiesXml", () => {
    const map = parseEndnotes(ENDNOTE_WITH_SDT);
    const endnote = map.byId.get(2);
    expect(endnote).toBeDefined();
    if (!endnote) {
      return;
    }
    expect(endnote.content).toHaveLength(1);
    const sdt = endnote.content[0];
    if (!sdt || sdt.type !== "blockSdt") {
      throw new TypeError("expected blockSdt at index 0");
    }
    expect(sdt.properties.tag).toBe("bound");
    // Data binding round-trips verbatim through rawPropertiesXml so a
    // later save replays it (the ContentControlBoundError contract from
    // PR #587 then guards mutations on the bound control).
    expect(sdt.properties.rawPropertiesXml).toContain("w:dataBinding");
    expect(sdt.properties.rawPropertiesXml).toContain('w:xpath="/cite/source"');
  });

  test("getFootnoteText recurses into block SDTs so citation slot text survives", () => {
    // Without the recursion, BlockSdt children added by the parser fix
    // would silently hide their inner paragraphs from text extraction.
    const map = parseFootnotes(FOOTNOTE_WITH_SDT);
    const footnote = map.byId.get(1);
    if (!footnote) {
      throw new TypeError("expected footnote");
    }
    const text = getFootnoteText(footnote);
    expect(text).toContain("before");
    expect(text).toContain("cited source");
    expect(text).toContain("after");
  });

  test("getEndnoteText recurses into block SDTs", () => {
    const map = parseEndnotes(ENDNOTE_WITH_SDT);
    const endnote = map.byId.get(2);
    if (!endnote) {
      throw new TypeError("expected endnote");
    }
    expect(getEndnoteText(endnote)).toBe("bound endnote");
  });
});
