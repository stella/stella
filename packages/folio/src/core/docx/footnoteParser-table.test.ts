import { describe, expect, test } from "bun:test";

import { parseEndnotes, parseFootnotes } from "./footnoteParser";

const FOOTNOTE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="1">
    <w:p><w:r><w:t>intro paragraph</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc>
          <w:p><w:r><w:t>cell text</w:t></w:r></w:p>
        </w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:t>after table</w:t></w:r></w:p>
  </w:footnote>
</w:footnotes>`;

const ENDNOTE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:endnote w:id="1">
    <w:p><w:r><w:t>endnote intro</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc>
          <w:p><w:r><w:t>endnote cell</w:t></w:r></w:p>
        </w:tc>
      </w:tr>
    </w:tbl>
  </w:endnote>
</w:endnotes>`;

describe("footnoteParser table content", () => {
  test("preserves footnote tables in document order", () => {
    const map = parseFootnotes(FOOTNOTE_XML);
    const footnote = map.byId.get(1);

    expect(footnote).toBeDefined();
    expect(footnote?.content.map((block) => block.type)).toEqual([
      "paragraph",
      "table",
      "paragraph",
    ]);
  });

  test("preserves endnote tables in document order", () => {
    const map = parseEndnotes(ENDNOTE_XML);
    const endnote = map.byId.get(1);

    expect(endnote).toBeDefined();
    expect(endnote?.content.map((block) => block.type)).toEqual([
      "paragraph",
      "table",
    ]);
  });
});
