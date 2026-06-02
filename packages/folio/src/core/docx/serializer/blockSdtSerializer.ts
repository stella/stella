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
import { reconcileRawSdtPr } from "../sdtPropertiesPatch";

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

function extractDropdownLastValue(blockSdt: BlockSdt): string | undefined {
  if (
    blockSdt.properties.sdtType !== "dropdown" &&
    blockSdt.properties.sdtType !== "comboBox"
  ) {
    return undefined;
  }
  // The dropdown's "current" value is the displayed text of the first run
  // in the SDT body. Mirrors what setContentControlValue writes back.
  const firstBlock = blockSdt.content[0];
  if (!firstBlock || firstBlock.type !== "paragraph") {
    return undefined;
  }
  const parts: string[] = [];
  for (const child of firstBlock.content) {
    if (child.type === "run") {
      for (const item of child.content) {
        if (item.type === "text") {
          parts.push(item.text);
        }
      }
    }
  }
  const text = parts.join("");
  if (text.length === 0) {
    return undefined;
  }
  // Map back from displayText to value when listItems are present so
  // Word's w:lastValue carries the OOXML value, not the friendly label.
  const items = blockSdt.properties.listItems;
  if (items) {
    const match = items.find((item) => item.displayText === text);
    if (match) {
      return match.value;
    }
  }
  return text;
}

function extractDateFullDate(blockSdt: BlockSdt): string | undefined {
  if (blockSdt.properties.sdtType !== "date") {
    return undefined;
  }
  // The ISO bound value lives on the modeled `dateValueISO`. We deliberately
  // do NOT read the SDT body — the body shows the format-rendered display
  // ("2 June 2026" per dateFormat "d MMMM yyyy") which would corrupt
  // `w:fullDate` (which OOXML requires to be ISO 8601). If the model has no
  // ISO value yet (e.g. a fresh control the user never picked a date for),
  // omit `w:fullDate` so the serializer doesn't write a garbage one.
  const iso = blockSdt.properties.dateValueISO;
  return iso !== undefined && iso.length > 0 ? iso : undefined;
}

export function serializeBlockSdt(
  blockSdt: BlockSdt,
  serializeChild: (block: BlockContent) => string,
): string {
  const props = blockSdt.properties;
  const baseSdtPr = props.rawPropertiesXml ?? serializeFallbackSdtPr(props);
  // Reconcile any modeled property mutations the editor may have made into
  // the raw XML before replay so checkbox / dropdown / date interactions
  // survive the round-trip. Unmodeled markers (dataBinding,
  // w15:repeatingSection, etc.) inside the raw string are preserved.
  const dateFullDate = extractDateFullDate(blockSdt);
  const dropdownLastValue = extractDropdownLastValue(blockSdt);
  const sdtPrXml = reconcileRawSdtPr(baseSdtPr, props, {
    ...(dateFullDate !== undefined ? { dateFullDate } : {}),
    ...(dropdownLastValue !== undefined ? { dropdownLastValue } : {}),
  });
  const sdtEndPrXml = props.rawEndPropertiesXml ?? "";
  const contentXml = blockSdt.content.map(serializeChild).join("");
  return `<w:sdt>${sdtPrXml}${sdtEndPrXml}<w:sdtContent>${contentXml}</w:sdtContent></w:sdt>`;
}
