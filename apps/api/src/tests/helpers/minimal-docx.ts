/**
 * The smallest valid DOCX around a document body: its content types, the
 * relationship naming the main document, and the document itself.
 */

import { ZipArchive } from "@stll/docx-core/zip";

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

const ROOT_RELATIONSHIPS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

/** A DOCX whose `w:body` holds `bodyXml`. */
export const minimalDocx = async (bodyXml: string): Promise<Uint8Array> => {
  const zip = new ZipArchive();
  zip.set("[Content_Types].xml", CONTENT_TYPES);
  zip.set("_rels/.rels", ROOT_RELATIONSHIPS);
  zip.set(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${bodyXml}</w:body>` +
      "</w:document>",
  );
  return await zip.generate({ compression: "store" });
};
