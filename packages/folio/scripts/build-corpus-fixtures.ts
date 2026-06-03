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
import { mkdirSync, writeFileSync } from "node:fs";
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

// Variant root that also declares the w16sdtdh namespace used by the
// dataHash content control extension.
const DATAHASH_DOC_OPEN = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash">`;

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

  // 6. Nested block SDTs — outer block SDT wraps another block SDT wraps a
  // paragraph. Block SDT property preservation is not yet on the parser
  // surface, so this asserts content fidelity only.
  {
    filename: "nested-block-sdt.docx",
    body: `
    <w:sdt>
      <w:sdtPr>
        <w:alias w:val="Outer wrapper"/>
        <w:tag w:val="outer-block"/>
      </w:sdtPr>
      <w:sdtContent>
        <w:sdt>
          <w:sdtPr>
            <w:alias w:val="Inner wrapper"/>
            <w:tag w:val="inner-block"/>
          </w:sdtPr>
          <w:sdtContent>
            <w:p><w:r><w:t>Nested content paragraph.</w:t></w:r></w:p>
          </w:sdtContent>
        </w:sdt>
      </w:sdtContent>
    </w:sdt>`,
  },

  // 7. SDT with run-formatted placeholder rPr (color + bold). Folio does not
  // currently project `<w:rPr>` from inside `<w:sdtPr>` onto the model, so
  // the assertion is structural — the parse must not classify the rPr child
  // as an SDT type and must not crash. Round-trip preserves the surrounding
  // alias/tag.
  {
    filename: "sdt-rpr-placeholder.docx",
    body: `
    <w:p>
      <w:sdt>
        <w:sdtPr>
          <w:rPr>
            <w:color w:val="FF0000"/>
            <w:b/>
          </w:rPr>
          <w:alias w:val="Coloured placeholder"/>
          <w:tag w:val="rpr-placeholder"/>
        </w:sdtPr>
        <w:sdtContent>
          <w:r><w:rPr><w:color w:val="FF0000"/><w:b/></w:rPr><w:t>Placeholder text.</w:t></w:r>
        </w:sdtContent>
      </w:sdt>
    </w:p>`,
  },

  // 8. Empty `<w:sdtContent/>`. Recovered model has an empty inline SDT;
  // the test asserts text recovery and that the round-trip does not inject
  // a synthetic empty run on save.
  {
    filename: "empty-sdt-content.docx",
    body: `
    <w:p>
      <w:r><w:t xml:space="preserve">Before: </w:t></w:r>
      <w:sdt>
        <w:sdtPr>
          <w:alias w:val="Empty slot"/>
          <w:tag w:val="empty-slot"/>
        </w:sdtPr>
        <w:sdtContent></w:sdtContent>
      </w:sdt>
      <w:r><w:t xml:space="preserve"> :after</w:t></w:r>
    </w:p>`,
  },

  // 9. Authored `<w:sdtContent><w:p/></w:sdtContent>` at block scope —
  // an authored empty paragraph must survive (not be dropped by the
  // synthetic-filler heuristic). Block SDT wrappers are unwrapped on parse;
  // the empty paragraph is what we follow through the round-trip.
  {
    filename: "authored-empty-paragraph.docx",
    body: `
    <w:p><w:r><w:t>Heading paragraph.</w:t></w:r></w:p>
    <w:sdt>
      <w:sdtPr>
        <w:alias w:val="Spacer"/>
        <w:tag w:val="spacer"/>
      </w:sdtPr>
      <w:sdtContent>
        <w:p/>
      </w:sdtContent>
    </w:sdt>
    <w:p><w:r><w:t>Trailing paragraph.</w:t></w:r></w:p>`,
  },

  // 10. Date with fractional seconds in `w:fullDate`. The parser keeps the
  // raw ISO timestamp in `dateFormat` (no separate dateValueISO field is
  // modeled), so the assertion is that the raw value with milliseconds is
  // preserved verbatim through the round-trip.
  {
    filename: "date-fractional-seconds.docx",
    body: `
    <w:p>
      <w:sdt>
        <w:sdtPr>
          <w:alias w:val="Signed at"/>
          <w:tag w:val="signed-at"/>
          <w:date w:fullDate="2026-06-02T00:00:00.000Z">
            <w:dateFormat w:val="yyyy-MM-dd"/>
            <w:lid w:val="en-US"/>
          </w:date>
        </w:sdtPr>
        <w:sdtContent>
          <w:r><w:t>2026-06-02</w:t></w:r>
        </w:sdtContent>
      </w:sdt>
    </w:p>`,
  },

  // 11. Dropdown with `<w:listItem w:value=""/>` selected as the SDT
  // content. The test asserts the empty value survives intact on the
  // `listItems` entry; the surrounding text round-trips unchanged.
  {
    filename: "dropdown-empty-value.docx",
    body: `
    <w:p>
      <w:r><w:t xml:space="preserve">Choose: </w:t></w:r>
      <w:sdt>
        <w:sdtPr>
          <w:alias w:val="Optional choice"/>
          <w:tag w:val="optional-choice"/>
          <w:dropDownList>
            <w:listItem w:displayText="(none)" w:value=""/>
            <w:listItem w:displayText="Yes" w:value="Y"/>
            <w:listItem w:displayText="No" w:value="N"/>
          </w:dropDownList>
        </w:sdtPr>
        <w:sdtContent>
          <w:r><w:t>(none)</w:t></w:r>
        </w:sdtContent>
      </w:sdt>
    </w:p>`,
  },

  // 12. Lock variant: `sdtLocked`.
  {
    filename: "lock-sdt-locked.docx",
    body: `
    <w:p>
      <w:sdt>
        <w:sdtPr>
          <w:alias w:val="SDT locked"/>
          <w:tag w:val="lock-sdt"/>
          <w:lock w:val="sdtLocked"/>
        </w:sdtPr>
        <w:sdtContent>
          <w:r><w:t>Wrapper is locked.</w:t></w:r>
        </w:sdtContent>
      </w:sdt>
    </w:p>`,
  },

  // 13. Lock variant: `contentLocked`.
  {
    filename: "lock-content-locked.docx",
    body: `
    <w:p>
      <w:sdt>
        <w:sdtPr>
          <w:alias w:val="Content locked"/>
          <w:tag w:val="lock-content"/>
          <w:lock w:val="contentLocked"/>
        </w:sdtPr>
        <w:sdtContent>
          <w:r><w:t>Content is locked.</w:t></w:r>
        </w:sdtContent>
      </w:sdt>
    </w:p>`,
  },

  // 14. Lock variant: `sdtContentLocked`.
  {
    filename: "lock-sdt-content-locked.docx",
    body: `
    <w:p>
      <w:sdt>
        <w:sdtPr>
          <w:alias w:val="Fully locked"/>
          <w:tag w:val="lock-both"/>
          <w:lock w:val="sdtContentLocked"/>
        </w:sdtPr>
        <w:sdtContent>
          <w:r><w:t>Both are locked.</w:t></w:r>
        </w:sdtContent>
      </w:sdt>
    </w:p>`,
  },

  // 15. `w15:repeatingSection` content control. The Document model does not
  // yet project a dedicated sdtType for it, so the parser falls back to
  // `richText`. The test asserts the wrapper text survives and the tag
  // round-trips; the marker itself is exercised so a future surface upgrade
  // can land regression-free.
  {
    filename: "repeating-section.docx",
    body: `
    <w:sdt>
      <w:sdtPr>
        <w:alias w:val="Schedule rows"/>
        <w:tag w:val="schedule-rows"/>
        <w15:repeatingSection/>
      </w:sdtPr>
      <w:sdtContent>
        <w:p><w:r><w:t>One row of the repeating section.</w:t></w:r></w:p>
      </w:sdtContent>
    </w:sdt>`,
  },

  // 16. `w14:checkbox` with `val="true"` (boolean form). The full ST_OnOff
  // spec accepts true/false/on/off in addition to 1/0; the parser must
  // recognise this as the checked state.
  {
    filename: "checkbox-val-true.docx",
    body: `
    <w:p>
      <w:sdt>
        <w:sdtPr>
          <w:alias w:val="Bool true"/>
          <w:tag w:val="bool-true"/>
          <w14:checkbox>
            <w14:checked w14:val="true"/>
          </w14:checkbox>
        </w:sdtPr>
        <w:sdtContent>
          <w:r><w:t xml:space="preserve">&#9746; </w:t></w:r>
        </w:sdtContent>
      </w:sdt>
      <w:r><w:t>Boolean true form.</w:t></w:r>
    </w:p>`,
  },

  // 17. `w14:checkbox` with `val="false"` (boolean form). Asserts the
  // unchecked state survives the round-trip without being silently flipped.
  {
    filename: "checkbox-val-false.docx",
    body: `
    <w:p>
      <w:sdt>
        <w:sdtPr>
          <w:alias w:val="Bool false"/>
          <w:tag w:val="bool-false"/>
          <w14:checkbox>
            <w14:checked w14:val="false"/>
          </w14:checkbox>
        </w:sdtPr>
        <w:sdtContent>
          <w:r><w:t xml:space="preserve">&#9744; </w:t></w:r>
        </w:sdtContent>
      </w:sdt>
      <w:r><w:t>Boolean false form.</w:t></w:r>
    </w:p>`,
  },

  // 18. Placeholder `docPart`. The OOXML shape is
  // `<w:placeholder><w:docPart w:val="..."/></w:placeholder>` (val is an
  // attribute on docPart). Asserts the placeholder string populates on the
  // SDT properties.
  {
    filename: "placeholder-docpart.docx",
    body: `
    <w:p>
      <w:sdt>
        <w:sdtPr>
          <w:alias w:val="Default text holder"/>
          <w:tag w:val="default-holder"/>
          <w:placeholder>
            <w:docPart w:val="DefaultText"/>
          </w:placeholder>
        </w:sdtPr>
        <w:sdtContent>
          <w:r><w:t>(placeholder)</w:t></w:r>
        </w:sdtContent>
      </w:sdt>
    </w:p>`,
  },

  // 19. `w16sdtdh:dataHash` inside sdtPr. The marker is not currently
  // projected to the model, but the parser must not mis-classify it as an
  // SDT type and the surrounding alias/tag must round-trip cleanly.
  {
    filename: "datahash-sdt.docx",
    body: `
    <w:p>
      <w:sdt>
        <w:sdtPr>
          <w:alias w:val="Hashed slot"/>
          <w:tag w:val="hashed-slot"/>
          <w16sdtdh:dataHash w16sdtdh:val="d41d8cd98f00b204e9800998ecf8427e"/>
        </w:sdtPr>
        <w:sdtContent>
          <w:r><w:t>Hashed content.</w:t></w:r>
        </w:sdtContent>
      </w:sdt>
    </w:p>`,
    documentOpenTag: DATAHASH_DOC_OPEN,
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
  mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const fixture of FIXTURES) {
    const buf = await buildFixture(fixture);
    const outPath = join(FIXTURES_DIR, fixture.filename);
    writeFileSync(outPath, Buffer.from(buf));
    console.log(`wrote ${outPath} (${buf.byteLength} bytes)`);
  }
}

await main();
