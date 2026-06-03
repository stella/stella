/**
 * Generator for the folio corpus round-trip DOCX fixtures.
 *
 * Produces small, hand-written DOCX packages exercising a few real OOXML
 * shapes (block SDTs, inline SDTs, dropdown lists, checkboxes, alt-prefix
 * namespaces). The generated files live in
 * `src/core/docx/__tests__/__fixtures__/corpus/` and are read by
 * `corpusRoundtrip.test.ts`.
 *
 * Run manually after editing this script:
 *   bun run scripts/build-corpus-fixtures.ts
 *
 * The script is intentionally not wired into a package script; fixtures are
 * checked in as binaries so tests stay offline and deterministic.
 */

import JSZip from "jszip";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = join(
  import.meta.dir,
  "..",
  "src",
  "core",
  "docx",
  "__tests__",
  "__fixtures__",
  "corpus",
);

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;

const SECTION_PROPS = `
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>`;

type Fixture = {
  filename: string;
  body: string;
  /** Optional override of the `w:document` open tag, e.g. for alt prefixes. */
  documentOpenTag?: string;
  documentCloseTag?: string;
};

const DEFAULT_DOC_OPEN = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">`;
const DEFAULT_DOC_CLOSE = `</w:document>`;

const FIXTURES: Fixture[] = [
  // 1. Block-level richText SDT wrapping a paragraph.
  {
    filename: "block-sdt-richtext.docx",
    body: `
    <w:sdt>
      <w:sdtPr>
        <w:alias w:val="Contract Title"/>
        <w:tag w:val="contract-title"/>
        <w:lock w:val="sdtContentLocked"/>
      </w:sdtPr>
      <w:sdtContent>
        <w:p>
          <w:r><w:t xml:space="preserve">Heads of Terms — </w:t></w:r>
          <w:r><w:rPr><w:b/></w:rPr><w:t>Project Acorn</w:t></w:r>
        </w:p>
      </w:sdtContent>
    </w:sdt>
    <w:p><w:r><w:t>Trailing paragraph.</w:t></w:r></w:p>`,
  },

  // 2. Inline SDT with a dropdown list inside a paragraph.
  {
    filename: "inline-sdt-dropdown.docx",
    body: `
    <w:p>
      <w:r><w:t xml:space="preserve">Governing law: </w:t></w:r>
      <w:sdt>
        <w:sdtPr>
          <w:alias w:val="Governing law"/>
          <w:tag w:val="governing-law"/>
          <w:dropDownList>
            <w:listItem w:displayText="England and Wales" w:value="EW"/>
            <w:listItem w:displayText="Czech Republic" w:value="CZ"/>
            <w:listItem w:displayText="Slovakia" w:value="SK"/>
          </w:dropDownList>
        </w:sdtPr>
        <w:sdtContent>
          <w:r><w:t>England and Wales</w:t></w:r>
        </w:sdtContent>
      </w:sdt>
      <w:r><w:t>.</w:t></w:r>
    </w:p>`,
  },

  // 3. Inline SDT with a w14:checkbox.
  {
    filename: "inline-sdt-checkbox.docx",
    body: `
    <w:p>
      <w:sdt>
        <w:sdtPr>
          <w:alias w:val="NDA accepted"/>
          <w:tag w:val="nda-accepted"/>
          <w14:checkbox>
            <w14:checked w14:val="1"/>
          </w14:checkbox>
        </w:sdtPr>
        <w:sdtContent>
          <w:r><w:t xml:space="preserve">&#9746; </w:t></w:r>
        </w:sdtContent>
      </w:sdt>
      <w:r><w:t>I accept the NDA.</w:t></w:r>
    </w:p>`,
  },

  // 4. Nested inline SDTs with mixed run properties inside the placeholder.
  {
    filename: "inline-sdt-mixed-rpr.docx",
    body: `
    <w:p>
      <w:sdt>
        <w:sdtPr>
          <w:alias w:val="Party block"/>
          <w:tag w:val="party-block"/>
          <w:lock w:val="sdtLocked"/>
        </w:sdtPr>
        <w:sdtContent>
          <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Buyer: </w:t></w:r>
          <w:sdt>
            <w:sdtPr>
              <w:alias w:val="Buyer name"/>
              <w:tag w:val="buyer-name"/>
            </w:sdtPr>
            <w:sdtContent>
              <w:r><w:rPr><w:i/></w:rPr><w:t>ACME, s.r.o.</w:t></w:r>
            </w:sdtContent>
          </w:sdt>
        </w:sdtContent>
      </w:sdt>
    </w:p>`,
  },

  // 5. Alt-prefix namespace declarations — common in non-Word producers.
  // Uses `x:` instead of `w:` for the main wordprocessingml namespace and a
  // non-default prefix for w14. Folio's parser must canonicalise these on
  // round-trip; the test asserts SDT properties survive regardless.
  {
    filename: "alt-prefix-sdt.docx",
    body: `
    <x:p>
      <x:r><x:t xml:space="preserve">Due date: </x:t></x:r>
      <x:sdt>
        <x:sdtPr>
          <x:alias x:val="Due date"/>
          <x:tag x:val="due-date"/>
          <x:date x:fullDate="2026-12-31T00:00:00Z">
            <x:dateFormat x:val="d MMMM yyyy"/>
            <x:lid x:val="en-GB"/>
          </x:date>
        </x:sdtPr>
        <x:sdtContent>
          <x:r><x:t>31 December 2026</x:t></x:r>
        </x:sdtContent>
      </x:sdt>
    </x:p>`,
    documentOpenTag: `<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`,
    documentCloseTag: `</x:document>`,
  },
];

async function buildFixture(fixture: Fixture): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", PACKAGE_RELS);
  zip.file("word/_rels/document.xml.rels", DOCUMENT_RELS);
  zip.file("word/styles.xml", STYLES_XML);

  const open = fixture.documentOpenTag ?? DEFAULT_DOC_OPEN;
  const close = fixture.documentCloseTag ?? DEFAULT_DOC_CLOSE;
  // Alt-prefix fixture also needs the body element to use the same prefix.
  const bodyTag = open.startsWith("<x:") ? "x:body" : "w:body";
  const sectPr = open.startsWith("<x:")
    ? SECTION_PROPS.replace(/w:/gu, "x:")
    : SECTION_PROPS;

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `${open}\n  <${bodyTag}>${fixture.body}${sectPr}\n  </${bodyTag}>\n${close}`;

  zip.file("word/document.xml", documentXml);

  return await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

async function main(): Promise<void> {
  for (const fixture of FIXTURES) {
    const buf = await buildFixture(fixture);
    const outPath = join(FIXTURES_DIR, fixture.filename);
    writeFileSync(outPath, Buffer.from(buf));
    console.log(`wrote ${outPath} (${buf.byteLength} bytes)`);
  }
}

await main();
