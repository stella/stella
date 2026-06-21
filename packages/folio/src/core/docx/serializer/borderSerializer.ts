/**
 * Shared single-border serializer for every `CT_Border` field — table borders
 * (`w:tblBorders`/`w:tcBorders`), paragraph borders (`w:pBdr`), and page borders
 * (`w:pgBorders`). The per-container helpers in the table/paragraph/section
 * serializers all delegate here so a border rule round-trips identically
 * everywhere; previously each carried its own copy and the same bug three times
 * (eigenpal/docx-editor#959).
 */

import type { BorderSpec } from "../../types/document";
import { escapeXml, intAttr } from "./xmlUtils";

/**
 * Serialize a single border element (`<w:top .../>`, `<w:left .../>`, ...).
 *
 * `nil`/`none` mean "no border", but an *explicit* one overrides an inherited
 * border (a table-level grid via `w:tblBorders`, a paragraph-style border, a
 * section page border), so it must still round-trip as `<w:side w:val="nil"/>`.
 * A `BorderSpec` only reaches here when the source set it or the user turned the
 * border off, so emitting it is faithful, not noise — dropping it silently
 * re-inherited the container default (e.g. hidden table gridlines reappeared as
 * a full grid on reload). `nil`/`none` carry no size/color/space, so emit just
 * the value.
 *
 * `style` and the color values come straight from the parsed DOCX (the parser
 * casts `w:val`/`w:color` without validating the enum), so they are
 * untrusted and are `escapeXml`'d before re-entering XML attributes; for valid
 * documents these are enum/hex values, so escaping is a no-op.
 */
export function serializeBorder(
  border: BorderSpec | undefined,
  elementName: string,
): string {
  if (!border) {
    return "";
  }

  if (border.style === "none" || border.style === "nil") {
    return `<w:${elementName} w:val="${border.style}"/>`;
  }

  const attrs: string[] = [`w:val="${escapeXml(border.style)}"`];

  if (border.size !== undefined) {
    attrs.push(`w:sz="${intAttr(border.size)}"`);
  }

  if (border.space !== undefined) {
    attrs.push(`w:space="${intAttr(border.space)}"`);
  }

  if (border.color) {
    if (border.color.auto) {
      attrs.push('w:color="auto"');
    } else if (border.color.rgb) {
      attrs.push(`w:color="${escapeXml(border.color.rgb)}"`);
    }

    if (border.color.themeColor) {
      attrs.push(`w:themeColor="${escapeXml(border.color.themeColor)}"`);
    }

    if (border.color.themeTint) {
      attrs.push(`w:themeTint="${escapeXml(border.color.themeTint)}"`);
    }

    if (border.color.themeShade) {
      attrs.push(`w:themeShade="${escapeXml(border.color.themeShade)}"`);
    }
  }

  if (border.shadow) {
    attrs.push('w:shadow="true"');
  }

  if (border.frame) {
    attrs.push('w:frame="true"');
  }

  // Custom page-border art relationship ids (only present on `w:pgBorders`
  // sides; undefined for table/paragraph borders, so skipped there).
  if (border.artRelationshipId) {
    attrs.push(`w:id="${escapeXml(border.artRelationshipId)}"`);
  }

  if (border.topLeftArtRelationshipId) {
    attrs.push(`w:topLeft="${escapeXml(border.topLeftArtRelationshipId)}"`);
  }

  if (border.topRightArtRelationshipId) {
    attrs.push(`w:topRight="${escapeXml(border.topRightArtRelationshipId)}"`);
  }

  if (border.bottomLeftArtRelationshipId) {
    attrs.push(
      `w:bottomLeft="${escapeXml(border.bottomLeftArtRelationshipId)}"`,
    );
  }

  if (border.bottomRightArtRelationshipId) {
    attrs.push(
      `w:bottomRight="${escapeXml(border.bottomRightArtRelationshipId)}"`,
    );
  }

  return `<w:${elementName} ${attrs.join(" ")}/>`;
}
