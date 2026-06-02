/**
 * Block-level SDT serializer.
 *
 * This commit keeps the existing alias/tag-only `<w:sdtPr>` emission to match
 * the parser's modeled-projection state. The next commit replaces the body
 * here with a raw `properties.rawPropertiesXml` replay so unmodeled OOXML
 * features (`w:dataBinding`, `w15:repeatingSection`, `w:sdtEndPr`, etc.)
 * round-trip losslessly.
 *
 * Sharing the helper between the document body and the header/footer
 * serializers keeps body↔HF parity in one place.
 */

import type { BlockContent, BlockSdt } from "../../types/document";

export function serializeBlockSdt(
  blockSdt: BlockSdt,
  serializeChild: (block: BlockContent) => string,
): string {
  const props = blockSdt.properties;
  const prParts: string[] = [];
  if (props.alias) {
    prParts.push(`<w:alias w:val="${props.alias}"/>`);
  }
  if (props.tag) {
    prParts.push(`<w:tag w:val="${props.tag}"/>`);
  }
  const contentXml = blockSdt.content.map(serializeChild).join("");
  return `<w:sdt><w:sdtPr>${prParts.join("")}</w:sdtPr><w:sdtContent>${contentXml}</w:sdtContent></w:sdt>`;
}
