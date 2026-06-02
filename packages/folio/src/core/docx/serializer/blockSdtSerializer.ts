/**
 * Block-level SDT serializer.
 *
 * Replays `<w:sdtPr>` (and `<w:sdtEndPr>` when present) verbatim from the
 * `rawPropertiesXml` / `rawEndPropertiesXml` strings captured by the parser.
 * That keeps OOXML element order intact (`CT_SdtPr` is an `xsd:sequence`,
 * ECMA-376 §17.5.2) and round-trips unmodeled features — `w:dataBinding`,
 * `w15:repeatingSection`, `@lastValue`, custom XML mappings — without us
 * having to enumerate them.
 *
 * If a `BlockSdt` was constructed programmatically (no parsed snapshot to
 * replay), fall back to a minimal projection from the modeled fields so the
 * result is still a valid `<w:sdt>`.
 *
 * Sharing the helper between the document body and the header/footer
 * serializers keeps body↔HF parity in one place.
 */

import type {
  BlockContent,
  BlockSdt,
  SdtProperties,
} from "../../types/document";

function escapeXmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function serializeFallbackSdtPr(props: SdtProperties): string {
  const parts: string[] = [];
  if (props.id !== undefined) {
    parts.push(`<w:id w:val="${props.id}"/>`);
  }
  if (props.alias) {
    parts.push(`<w:alias w:val="${escapeXmlAttr(props.alias)}"/>`);
  }
  if (props.tag) {
    parts.push(`<w:tag w:val="${escapeXmlAttr(props.tag)}"/>`);
  }
  if (props.lock) {
    parts.push(`<w:lock w:val="${props.lock}"/>`);
  }
  if (props.placeholder) {
    parts.push(
      `<w:placeholder><w:docPart w:val="${escapeXmlAttr(props.placeholder)}"/></w:placeholder>`,
    );
  }
  if (props.showingPlaceholder) {
    parts.push("<w:showingPlcHdr/>");
  }
  return `<w:sdtPr>${parts.join("")}</w:sdtPr>`;
}

export function serializeBlockSdt(
  blockSdt: BlockSdt,
  serializeChild: (block: BlockContent) => string,
): string {
  const props = blockSdt.properties;
  const sdtPrXml = props.rawPropertiesXml ?? serializeFallbackSdtPr(props);
  const sdtEndPrXml = props.rawEndPropertiesXml ?? "";
  const contentXml = blockSdt.content.map(serializeChild).join("");
  return `<w:sdt>${sdtPrXml}${sdtEndPrXml}<w:sdtContent>${contentXml}</w:sdtContent></w:sdt>`;
}
