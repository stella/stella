import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { extractText, extractTextForPreview } from "./extract-text";

/** Build a minimal DOCX buffer with the given document.xml. */
const makeDocx = async (
  documentXml: string,
  numberingXml?: string,
): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  if (numberingXml !== undefined) {
    zip.file("word/numbering.xml", numberingXml);
  }
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;

describe("extractText", () => {
  test("extracts paragraphs with text", async () => {
    const xml = WRAP(
      `<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>
       <w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>`,
    );
    const buf = await makeDocx(xml);
    const result = await extractText(buf);

    expect(result.paragraphs).toHaveLength(2);
    expect(result.paragraphs[0]).toEqual({
      index: 0,
      text: "Hello world",
      source: "body",
    });
    expect(result.paragraphs[1]).toEqual({
      index: 1,
      text: "Second paragraph",
      source: "body",
    });
    expect(result.charCount).toBe(
      "Hello world".length + "Second paragraph".length,
    );
  });

  test("reads paragraph style", async () => {
    const xml = WRAP(
      `<w:p>
        <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
        <w:r><w:t>Title</w:t></w:r>
      </w:p>`,
    );
    const buf = await makeDocx(xml);
    const result = await extractText(buf);

    expect(result.paragraphs[0]?.style).toBe("Heading1");
  });

  test("concatenates text across runs", async () => {
    const xml = WRAP(
      `<w:p>
        <w:r><w:t>Hello </w:t></w:r>
        <w:r><w:t>world</w:t></w:r>
      </w:p>`,
    );
    const buf = await makeDocx(xml);
    const result = await extractText(buf);

    expect(result.paragraphs[0]?.text).toBe("Hello world");
  });

  test("skips deleted text", async () => {
    const xml = WRAP(
      `<w:p>
        <w:r><w:t>Keep this</w:t></w:r>
        <w:del w:id="1" w:author="AI">
          <w:r><w:delText>Remove this</w:delText></w:r>
        </w:del>
      </w:p>`,
    );
    const buf = await makeDocx(xml);
    const result = await extractText(buf);

    expect(result.paragraphs[0]?.text).toBe("Keep this");
  });

  test("includes empty paragraphs with index", async () => {
    const xml = WRAP(
      `<w:p><w:r><w:t>First</w:t></w:r></w:p>
       <w:p></w:p>
       <w:p><w:r><w:t>Third</w:t></w:r></w:p>`,
    );
    const buf = await makeDocx(xml);
    const result = await extractText(buf);

    expect(result.paragraphs).toHaveLength(3);
    expect(result.paragraphs[1]).toEqual({
      index: 1,
      text: "",
      source: "body",
    });
  });

  test("handles missing document.xml", async () => {
    const zip = new JSZip();
    zip.file("other.xml", "<root/>");
    const buf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    const result = await extractText(buf);

    expect(result.paragraphs).toEqual([]);
    expect(result.charCount).toBe(0);
  });

  // ── Directive annotation ───────────────────────────────

  test("annotates #if open and /if close directives", async () => {
    const xml = WRAP(
      `<w:p><w:r><w:t>{% if active %}</w:t></w:r></w:p>
       <w:p><w:r><w:t>Content</w:t></w:r></w:p>
       <w:p><w:r><w:t>{% endif %}</w:t></w:r></w:p>`,
    );
    const buf = await makeDocx(xml);
    const result = await extractText(buf);

    expect(result.paragraphs[0]).toEqual({
      index: 0,
      text: "{% if active %}",
      source: "body",
      isDirective: true,
      directiveKind: "if",
      directiveExpression: "active",
    });
    expect(result.paragraphs[1]).toEqual({
      index: 1,
      text: "Content",
      source: "body",
    });
    expect(result.paragraphs[2]).toEqual({
      index: 2,
      text: "{% endif %}",
      source: "body",
      isDirective: true,
      directiveKind: "endif",
      directiveExpression: "",
    });
  });

  test("annotates a {% for %} directive", async () => {
    const xml = WRAP(
      `<w:p><w:r><w:t>{% for item in items %}</w:t></w:r></w:p>
       <w:p><w:r><w:t>{{ item.name }}</w:t></w:r></w:p>
       <w:p><w:r><w:t>{% endfor %}</w:t></w:r></w:p>`,
    );
    const buf = await makeDocx(xml);
    const result = await extractText(buf);

    expect(result.paragraphs[0]).toEqual({
      index: 0,
      text: "{% for item in items %}",
      source: "body",
      isDirective: true,
      directiveKind: "for",
      directiveExpression: "item in items",
    });
    expect(result.paragraphs[2]).toEqual({
      index: 2,
      text: "{% endfor %}",
      source: "body",
      isDirective: true,
      directiveKind: "endfor",
      directiveExpression: "",
    });
  });

  test("annotates a block directive stored in a table cell", async () => {
    const xml = WRAP(
      `<w:tbl><w:tr><w:tc>
        <w:p><w:r><w:t>{% for field in fields %}</w:t></w:r></w:p>
      </w:tc></w:tr></w:tbl>`,
    );
    const buf = await makeDocx(xml);
    const result = await extractText(buf);

    expect(result.paragraphs[2]).toEqual({
      index: 2,
      text: "| {% for field in fields %} |",
      source: "body",
      tableRow: {
        table: 0,
        kind: "cells",
        cells: [{ paragraphs: [{ text: "{% for field in fields %}" }] }],
      },
      isDirective: true,
      directiveKind: "for",
      directiveExpression: "field in fields",
    });
  });

  test("restores table-cell paragraphs for template preview", async () => {
    const xml = WRAP(
      `<w:tbl><w:tr>
        <w:tc>
          <w:p><w:r><w:t>{% for field in fields %}</w:t></w:r></w:p>
          <w:p><w:r><w:t>{{ field.label }}</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:p><w:r><w:t>{{ field.value }}</w:t></w:r></w:p>
          <w:p><w:r><w:t>{% endfor %}</w:t></w:r></w:p>
        </w:tc>
      </w:tr></w:tbl>`,
    );
    const buf = await makeDocx(xml);
    const result = await extractTextForPreview(buf);

    expect(result.paragraphs).toEqual([
      {
        index: 0,
        text: "{% for field in fields %}",
        source: "body",
        isDirective: true,
        directiveKind: "for",
        directiveExpression: "field in fields",
      },
      { index: 1, text: "{{ field.label }}", source: "body" },
      { index: 2, text: "{{ field.value }}", source: "body" },
      {
        index: 3,
        text: "{% endfor %}",
        source: "body",
        isDirective: true,
        directiveKind: "endfor",
        directiveExpression: "",
      },
    ]);
    expect(result.charCount).toBe(
      "{% for field in fields %}{{ field.label }}{{ field.value }}{% endfor %}"
        .length,
    );
  });

  test("preserves table-cell formatting for template preview", async () => {
    const xml = WRAP(
      `<w:tbl><w:tr><w:tc>
        <w:p>
          <w:pPr>
            <w:pStyle w:val="Heading1"/>
            <w:jc w:val="center"/>
          </w:pPr>
          <w:r>
            <w:rPr><w:b/><w:sz w:val="32"/></w:rPr>
            <w:t>Styled cell</w:t>
          </w:r>
        </w:p>
      </w:tc></w:tr></w:tbl>`,
    );
    const buf = await makeDocx(xml);
    const result = await extractTextForPreview(buf);

    expect(result.paragraphs).toEqual([
      {
        index: 0,
        text: "Styled cell",
        source: "body",
        style: "Heading1",
        alignment: "center",
        bold: true,
        fontSize: 32,
      },
    ]);
  });

  test("annotates {% elif %} and {% else %} directives", async () => {
    const xml = WRAP(
      `<w:p><w:r><w:t>{% if a %}</w:t></w:r></w:p>
       <w:p><w:r><w:t>A</w:t></w:r></w:p>
       <w:p><w:r><w:t>{% elif b %}</w:t></w:r></w:p>
       <w:p><w:r><w:t>B</w:t></w:r></w:p>
       <w:p><w:r><w:t>{% else %}</w:t></w:r></w:p>
       <w:p><w:r><w:t>C</w:t></w:r></w:p>
       <w:p><w:r><w:t>{% endif %}</w:t></w:r></w:p>`,
    );
    const buf = await makeDocx(xml);
    const result = await extractText(buf);

    expect(result.paragraphs[2]).toEqual({
      index: 2,
      text: "{% elif b %}",
      source: "body",
      isDirective: true,
      directiveKind: "elif",
      directiveExpression: "b",
    });
    expect(result.paragraphs[4]).toEqual({
      index: 4,
      text: "{% else %}",
      source: "body",
      isDirective: true,
      directiveKind: "else",
      directiveExpression: "",
    });
  });

  test("preserves complex directive expressions", async () => {
    const xml = WRAP(
      `<w:p><w:r><w:t>{% if status == "active" and count > 0 %}</w:t></w:r></w:p>
       <w:p><w:r><w:t>{% endif %}</w:t></w:r></w:p>`,
    );
    const buf = await makeDocx(xml);
    const result = await extractText(buf);

    expect(result.paragraphs[0]).toEqual({
      index: 0,
      text: '{% if status == "active" and count > 0 %}',
      source: "body",
      isDirective: true,
      directiveKind: "if",
      directiveExpression: 'status == "active" and count > 0',
    });
  });

  test("does not annotate non-directive placeholders", async () => {
    const xml = WRAP(
      `<w:p><w:r><w:t>{{clientName}}</w:t></w:r></w:p>
       <w:p><w:r><w:t>Hello {{name}}, welcome.</w:t></w:r></w:p>`,
    );
    const buf = await makeDocx(xml);
    const result = await extractText(buf);

    expect(result.paragraphs[0]).toEqual({
      index: 0,
      text: "{{clientName}}",
      source: "body",
    });
    expect(result.paragraphs[1]).toEqual({
      index: 1,
      text: "Hello {{name}}, welcome.",
      source: "body",
    });
  });

  test("directive annotation coexists with style", async () => {
    const xml = WRAP(
      `<w:p>
        <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
        <w:r><w:t>{% if show %}</w:t></w:r>
      </w:p>`,
    );
    const buf = await makeDocx(xml);
    const result = await extractText(buf);

    expect(result.paragraphs[0]).toEqual({
      index: 0,
      text: "{% if show %}",
      source: "body",
      style: "Normal",
      isDirective: true,
      directiveKind: "if",
      directiveExpression: "show",
    });
  });

  test("works on the SPA fixture", async () => {
    const fixture = new URL("fixtures/spa-template.docx", import.meta.url)
      .pathname;
    const file = Bun.file(fixture);
    const buf = Buffer.from(await file.arrayBuffer());
    const result = await extractText(buf);

    expect(result.paragraphs.length).toBeGreaterThan(10);
    expect(result.charCount).toBeGreaterThan(100);
    // Should have some styled paragraphs
    const styled = result.paragraphs.filter((p) => p.style);
    expect(styled.length).toBeGreaterThan(0);
  });
});
