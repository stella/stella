/**
 * The smallest DOCX that declares a set of markers.
 *
 * The document is the template, so a test that needs a template needs bytes a
 * marker scan can read. One builder, so a fixture cannot accidentally produce
 * a package the discovery pipeline reads differently from the real one.
 */

import { minimalDocx } from "./minimal-docx";

const paragraph = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/** A DOCX whose body is one `{{ path }}` marker per entry, in order. */
export const docxWithMarkers = async (
  markers: readonly string[],
): Promise<Buffer> =>
  Buffer.from(
    await minimalDocx(
      markers.map((marker) => paragraph(`{{ ${marker} }}`)).join(""),
    ),
  );
