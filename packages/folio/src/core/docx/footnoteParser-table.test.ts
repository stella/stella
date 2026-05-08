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

const ALT_PREFIX_FOOTNOTE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<n:footnotes xmlns:n="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <n:footnote n:id="1">
    <n:p><n:r><n:t>intro paragraph</n:t></n:r></n:p>
    <n:tbl>
      <n:tr>
        <n:tc>
          <n:p><n:r><n:t>cell text</n:t></n:r></n:p>
        </n:tc>
      </n:tr>
    </n:tbl>
  </n:footnote>
</n:footnotes>`;

const ALT_PREFIX_ENDNOTE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<n:endnotes xmlns:n="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <n:endnote n:id="1">
    <n:p><n:r><n:t>endnote intro</n:t></n:r></n:p>
    <n:tbl>
      <n:tr>
        <n:tc>
          <n:p><n:r><n:t>endnote cell</n:t></n:r></n:p>
        </n:tc>
      </n:tr>
    </n:tbl>
  </n:endnote>
</n:endnotes>`;

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

  test("parses footnote block content with alternate namespace prefixes", () => {
    const map = parseFootnotes(ALT_PREFIX_FOOTNOTE_XML);
    const footnote = map.byId.get(1);

    expect(footnote).toBeDefined();
    expect(footnote?.content.map((block) => block.type)).toEqual([
      "paragraph",
      "table",
    ]);
  });

  test("parses endnote block content with alternate namespace prefixes", () => {
    const map = parseEndnotes(ALT_PREFIX_ENDNOTE_XML);
    const endnote = map.byId.get(1);

    expect(endnote).toBeDefined();
    expect(endnote?.content.map((block) => block.type)).toEqual([
      "paragraph",
      "table",
    ]);
  });
});
