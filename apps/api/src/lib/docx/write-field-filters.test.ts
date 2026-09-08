import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { discoverTemplate } from "./discover-template";
import {
  arrayFiltersFromFieldMeta,
  filtersFromFieldMeta,
} from "./field-filters";
import type { FieldMeta } from "./types";
import { unwritableRewrites, writeFieldFilters } from "./write-field-filters";

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

/** A paragraph whose text is split across runs, which is what Word produces
 *  the moment an author edits inside a marker. */
const splitP = (parts: readonly string[]) =>
  `<w:p>${parts.map((part) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${part}</w:t></w:r>`).join("")}</w:p>`;

const makeDocx = async (
  paragraphs: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", WRAP(paragraphs.join("")));
  for (const [path, xml] of Object.entries(extra)) {
    zip.file(path, xml);
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

const documentXml = async (buffer: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) {
    throw new Error("no main document part");
  }
  return await entry.async("string");
};

const rewrite = (field: FieldMeta) => ({
  path: field.path,
  filters: filtersFromFieldMeta(field),
});

describe("writing a configuration into the document", () => {
  test("a plain marker gains the chain its field declares", async () => {
    const docx = await makeDocx([P("Deposit: {{ deposit }}")]);
    const { buffer, written } = await writeFieldFilters(docx, [
      rewrite({
        path: "deposit",
        inputType: "number",
        label: "Kaution",
        required: true,
      }),
    ]);

    expect(written).toEqual(new Set(["deposit"]));
    expect(await documentXml(buffer)).toContain(
      '{{ deposit | number | label("Kaution") | required }}',
    );
  });

  test("every occurrence of the path is rewritten, in every part", async () => {
    const header =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `${P("{{ client }}")}</w:hdr>`;
    const docx = await makeDocx([P("{{ client }}"), P("and {{ client }}")], {
      "word/header1.xml": header,
    });

    const { buffer } = await writeFieldFilters(docx, [
      rewrite({ path: "client", label: "Client" }),
    ]);

    const zip = await JSZip.loadAsync(buffer);
    const body = await documentXml(buffer);
    const headerXml = await zip.file("word/header1.xml")?.async("string");
    expect(body.match(/label\("Client"\)/gu)).toHaveLength(2);
    expect(headerXml).toContain('{{ client | label("Client") }}');
  });

  test("a marker split across runs keeps its formatting", async () => {
    const docx = await makeDocx([splitP(["Fee: {{ fe", "e }} due"])]);
    const { buffer } = await writeFieldFilters(docx, [
      rewrite({ path: "fee", inputType: "number" }),
    ]);

    const xml = await documentXml(buffer);
    expect(xml).toContain("{{ fee | number }}");
    expect(xml).toContain("<w:b/>");
    const discovered = await discoverTemplate(buffer);
    expect(discovered.documentFields).toEqual([
      { path: "fee", inputType: "number" },
    ]);
  });

  test("a loop item is addressed by the path the manifest speaks", async () => {
    const docx = await makeDocx([
      P("{% for attorney in attorneys %}"),
      P("{{ attorney.name }}"),
      P("{% endfor %}"),
    ]);

    const { buffer, written } = await writeFieldFilters(docx, [
      rewrite({ path: "attorneys.name", label: "Full name" }),
    ]);

    expect(written).toEqual(new Set(["attorneys.name"]));
    // The marker keeps the alias the body wrote: renaming it would move the
    // field out of the loop.
    expect(await documentXml(buffer)).toContain(
      '{{ attorney.name | label("Full name") }}',
    );
  });

  test("a repeat's own filters land on the opener, keeping its placement", async () => {
    const docx = await makeDocx([
      P("{%p for item in items %}"),
      P("{{ item.name }}"),
      P("{%p endfor %}"),
    ]);

    const { buffer, written } = await writeFieldFilters(docx, [
      {
        path: "items",
        filters: arrayFiltersFromFieldMeta({
          path: "items",
          label: "Items",
          // A value filter has no meaning on a repeat, and the array writer is
          // derived from the same list the reader refuses them with.
          inputType: "number",
          validation: { minItems: 1, maxItems: 5 },
        }),
      },
    ]);

    expect(written).toEqual(new Set(["items"]));
    expect(await documentXml(buffer)).toContain(
      '{%p for item in items | label("Items") | min_items(1) | max_items(5) %}',
    );
  });

  test("asking for what the markers already say returns the same bytes", async () => {
    const docx = await makeDocx([P('{{ deposit | number | label("Kaution") }}')]);
    const field: FieldMeta = {
      path: "deposit",
      inputType: "number",
      label: "Kaution",
    };

    const { buffer, written } = await writeFieldFilters(docx, [rewrite(field)]);

    expect(written).toEqual(new Set(["deposit"]));
    expect(buffer).toBe(docx);
  });

  test("a path the document does not carry is not reported as written", async () => {
    const docx = await makeDocx([P("{{ deposit }}")]);
    const { written } = await writeFieldFilters(docx, [
      rewrite({ path: "missing", label: "Nope" }),
    ]);

    expect(written).toEqual(new Set());
  });

  test("the rewritten document discovers the configuration it was given", async () => {
    const docx = await makeDocx([
      P("{{ deposit }} {{ signed_on }}"),
      P("{% for attorney in attorneys %}"),
      P("{{ attorney.name }}"),
      P("{% endfor %}"),
    ]);
    const fields: FieldMeta[] = [
      { path: "deposit", inputType: "number", required: true },
      {
        path: "signed_on",
        inputType: "date",
        dateFormat: { locale: "cs", style: "long" },
      },
      { path: "attorneys.name", label: "Full name", hint: "As in the ID" },
    ];

    const { buffer } = await writeFieldFilters(docx, fields.map(rewrite));
    const discovered = await discoverTemplate(buffer);

    expect(discovered.structureErrors).toEqual([]);
    expect(discovered.documentFields).toEqual([
      { path: "attorneys.name", label: "Full name", hint: "As in the ID" },
      {
        path: "deposit",
        inputType: "number",
        required: true,
        validation: { required: true },
      },
      {
        path: "signed_on",
        inputType: "date",
        dateFormat: { locale: "cs", style: "long" },
      },
    ]);
  });

  test("rewriting an already configured marker replaces its chain", async () => {
    const docx = await makeDocx([P('{{ deposit | text | label("Old") }}')]);
    const { buffer } = await writeFieldFilters(docx, [
      rewrite({ path: "deposit", inputType: "number", label: "New" }),
    ]);

    const xml = await documentXml(buffer);
    expect(xml).toContain('{{ deposit | number | label("New") }}');
    expect(xml).not.toContain("Old");
  });

  test("a brace has no marker spelling, and is named before the write", () => {
    expect(
      unwritableRewrites([
        {
          path: "deposit",
          filters: filtersFromFieldMeta({
            path: "deposit",
            label: "a { b",
          }),
        },
      ]),
    ).toEqual([{ path: "deposit", filter: "label", value: "a { b" }]);
  });
});
