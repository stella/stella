/**
 * The smallest DOCX that declares a set of markers.
 *
 * The document is the template, so a test that needs a template needs bytes a
 * marker scan can read. One builder, so a fixture cannot accidentally produce
 * a package the discovery pipeline reads differently from the real one.
 */

import JSZip from "jszip";

const paragraph = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/** A DOCX whose body is one `{{ path }}` marker per entry, in order. */
export const docxWithMarkers = async (
  markers: readonly string[],
): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${markers.map((marker) => paragraph(`{{ ${marker} }}`)).join("")}</w:body>` +
      "</w:document>",
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};
