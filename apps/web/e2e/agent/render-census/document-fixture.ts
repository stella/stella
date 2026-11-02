import { readFile } from "node:fs/promises";
import path from "node:path";

import { ZipArchive } from "@stll/docx-core/zip";

import { createOutlinePages } from "./legal-fixtures";

const escapeXmlText = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const createOutlineDocument = async () => {
  const zip = await ZipArchive.read(
    await readFile(
      path.resolve(import.meta.dirname, "../../fixtures/simple.docx"),
    ),
  );
  const paragraphs: string[] = [];
  for (const [page, clauses] of createOutlinePages().entries()) {
    if (page > 0) {
      paragraphs.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    }
    for (const clause of clauses) {
      paragraphs.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${escapeXmlText(clause.heading)}</w:t></w:r></w:p>`,
        `<w:p><w:r><w:t>${escapeXmlText(clause.paragraph)}</w:t></w:r></w:p>`,
      );
    }
  }
  zip.set(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  );
  zip.set(
    "word/styles.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>',
  );
  return Buffer.from(await zip.generate({ compression: "store" }));
};
