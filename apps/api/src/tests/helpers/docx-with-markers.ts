/**
 * The smallest DOCX that declares a set of markers.
 *
 * The document is the template, so a test that needs a template needs bytes a
 * marker scan can read. One builder, so a fixture cannot accidentally produce
 * a package the discovery pipeline reads differently from the real one.
 */

import { ZipArchive } from "@stll/docx-core/zip";

const paragraph = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/** A DOCX whose body is one `{{ path }}` marker per entry, in order. */
export const docxWithMarkers = async (
  markers: readonly string[],
): Promise<Buffer> => {
  const zip = new ZipArchive();
  // The package parts every valid DOCX carries: its content types and the
  // relationship naming the main document.
  zip.set(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  );
  zip.set(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
  );
  zip.set(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${markers.map((marker) => paragraph(`{{ ${marker} }}`)).join("")}</w:body>` +
      "</w:document>",
  );
  return Buffer.from(Buffer.from(await zip.generate({ compression: "store" })));
};
