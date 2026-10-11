/**
 * Generates the small DOCX fixtures used by the e2e suite.
 * Run when you need to refresh the fixture:
 *   bun apps/web/e2e/fixtures/generate.ts
 *
 * The output is committed so CI doesn't need to regenerate.
 */
import JSZip from "jszip";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>stella E2E test document.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Used to verify upload + inspector rendering.</w:t></w:r></w:p>
  </w:body>
</w:document>`;

const zip = new JSZip();
zip.file("[Content_Types].xml", contentTypesXml);
zip.folder("_rels")?.file(".rels", rootRelsXml);
zip.folder("word")?.file("document.xml", documentXml);

const out = await zip.generateAsync({
  type: "uint8array",
  compression: "DEFLATE",
});
const target = path.resolve(import.meta.dirname, "simple.docx");
await writeFile(target, out);
console.log(`wrote ${target} (${String(out.byteLength)} bytes)`);

// Two outline entries make the outline available; explicit A4 dimensions
// exercise page fitting independently of editor defaults.
zip.file(
  "word/document.xml",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Template fit heading</w:t></w:r></w:p>
    <w:p><w:r><w:t>E2E page fit document.</w:t></w:r></w:p>
    <w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>Template fit subheading</w:t></w:r></w:p>
    <w:p><w:r><w:t>Used to verify fitting with the outline and inspector.</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`,
);
const fitOutput = await zip.generateAsync({
  type: "uint8array",
  compression: "DEFLATE",
});
const fitTarget = path.resolve(import.meta.dirname, "template-fit.docx");
await writeFile(fitTarget, fitOutput);
console.log(`wrote ${fitTarget} (${String(fitOutput.byteLength)} bytes)`);
