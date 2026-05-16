import type {
  BorderSpec,
  EndnoteProperties,
  FooterReference,
  FootnoteProperties,
  HeaderReference,
  SectionProperties,
} from "../../types/document";
import { getUnserializedSectionPropertyChildNames } from "../sectionParser";
import { intAttr } from "./xmlUtils";

function serializeBorder(
  border: BorderSpec | undefined,
  elementName: string,
): string {
  if (!border || border.style === "none" || border.style === "nil") {
    return "";
  }

  const attrs: string[] = [`w:val="${border.style}"`];

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
      attrs.push(`w:color="${border.color.rgb}"`);
    }
    if (border.color.themeColor) {
      attrs.push(`w:themeColor="${border.color.themeColor}"`);
    }
    if (border.color.themeTint) {
      attrs.push(`w:themeTint="${border.color.themeTint}"`);
    }
    if (border.color.themeShade) {
      attrs.push(`w:themeShade="${border.color.themeShade}"`);
    }
  }
  if (border.shadow) {
    attrs.push('w:shadow="true"');
  }
  if (border.frame) {
    attrs.push('w:frame="true"');
  }

  return `<w:${elementName} ${attrs.join(" ")}/>`;
}

const serializeHeaderReference = (ref: HeaderReference): string =>
  `<w:headerReference w:type="${ref.type}" r:id="${ref.rId}"/>`;

const serializeFooterReference = (ref: FooterReference): string =>
  `<w:footerReference w:type="${ref.type}" r:id="${ref.rId}"/>`;

function serializeFootnoteProperties(
  props: FootnoteProperties | undefined,
): string {
  if (!props) {
    return "";
  }

  const parts: string[] = [];
  if (props.position) {
    parts.push(`<w:pos w:val="${props.position}"/>`);
  }
  if (props.numFmt) {
    parts.push(`<w:numFmt w:val="${props.numFmt}"/>`);
  }
  if (props.numStart !== undefined) {
    parts.push(`<w:numStart w:val="${intAttr(props.numStart)}"/>`);
  }
  if (props.numRestart) {
    parts.push(`<w:numRestart w:val="${props.numRestart}"/>`);
  }

  return parts.length > 0
    ? `<w:footnotePr>${parts.join("")}</w:footnotePr>`
    : "";
}

function serializeEndnoteProperties(
  props: EndnoteProperties | undefined,
): string {
  if (!props) {
    return "";
  }

  const parts: string[] = [];
  if (props.position) {
    parts.push(`<w:pos w:val="${props.position}"/>`);
  }
  if (props.numFmt) {
    parts.push(`<w:numFmt w:val="${props.numFmt}"/>`);
  }
  if (props.numStart !== undefined) {
    parts.push(`<w:numStart w:val="${intAttr(props.numStart)}"/>`);
  }
  if (props.numRestart) {
    parts.push(`<w:numRestart w:val="${props.numRestart}"/>`);
  }

  return parts.length > 0 ? `<w:endnotePr>${parts.join("")}</w:endnotePr>` : "";
}

function serializePageSize(props: SectionProperties): string {
  const attrs: string[] = [];
  if (props.pageWidth !== undefined) {
    attrs.push(`w:w="${intAttr(props.pageWidth)}"`);
  }
  if (props.pageHeight !== undefined) {
    attrs.push(`w:h="${intAttr(props.pageHeight)}"`);
  }
  if (props.orientation === "landscape") {
    attrs.push('w:orient="landscape"');
  }
  return attrs.length > 0 ? `<w:pgSz ${attrs.join(" ")}/>` : "";
}

function serializePageMargins(props: SectionProperties): string {
  const attrs: string[] = [];
  if (props.marginTop !== undefined) {
    attrs.push(`w:top="${intAttr(props.marginTop)}"`);
  }
  if (props.marginRight !== undefined) {
    attrs.push(`w:right="${intAttr(props.marginRight)}"`);
  }
  if (props.marginBottom !== undefined) {
    attrs.push(`w:bottom="${intAttr(props.marginBottom)}"`);
  }
  if (props.marginLeft !== undefined) {
    attrs.push(`w:left="${intAttr(props.marginLeft)}"`);
  }
  if (props.headerDistance !== undefined) {
    attrs.push(`w:header="${intAttr(props.headerDistance)}"`);
  }
  if (props.footerDistance !== undefined) {
    attrs.push(`w:footer="${intAttr(props.footerDistance)}"`);
  }
  if (props.gutter !== undefined) {
    attrs.push(`w:gutter="${intAttr(props.gutter)}"`);
  }
  return attrs.length > 0 ? `<w:pgMar ${attrs.join(" ")}/>` : "";
}

function serializePaperSource(props: SectionProperties): string {
  const attrs: string[] = [];
  if (props.paperSrcFirst !== undefined) {
    attrs.push(`w:first="${intAttr(props.paperSrcFirst)}"`);
  }
  if (props.paperSrcOther !== undefined) {
    attrs.push(`w:other="${intAttr(props.paperSrcOther)}"`);
  }
  return attrs.length > 0 ? `<w:paperSrc ${attrs.join(" ")}/>` : "";
}

function serializeColumns(props: SectionProperties): string {
  if (!props.columnCount && !props.columns?.length) {
    return "";
  }

  const attrs: string[] = [];
  if (props.columnCount !== undefined && props.columnCount > 1) {
    attrs.push(`w:num="${intAttr(props.columnCount)}"`);
  }
  if (props.columnSpace !== undefined) {
    attrs.push(`w:space="${intAttr(props.columnSpace)}"`);
  }
  if (props.equalWidth !== undefined) {
    attrs.push(`w:equalWidth="${props.equalWidth ? "1" : "0"}"`);
  }
  if (props.separator) {
    attrs.push('w:sep="1"');
  }

  const colElements = (props.columns ?? [])
    .map((col) => {
      const colAttrs: string[] = [];
      if (col.width !== undefined) {
        colAttrs.push(`w:w="${intAttr(col.width)}"`);
      }
      if (col.space !== undefined) {
        colAttrs.push(`w:space="${intAttr(col.space)}"`);
      }
      return `<w:col ${colAttrs.join(" ")}/>`;
    })
    .join("");

  if (attrs.length === 0 && !colElements) {
    return "";
  }

  const attrsStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  return `<w:cols${attrsStr}>${colElements}</w:cols>`;
}

function serializeLineNumbers(props: SectionProperties): string {
  if (!props.lineNumbers) {
    return "";
  }

  const attrs: string[] = [];
  const ln = props.lineNumbers;
  if (ln.countBy !== undefined) {
    attrs.push(`w:countBy="${intAttr(ln.countBy)}"`);
  }
  if (ln.start !== undefined) {
    attrs.push(`w:start="${intAttr(ln.start)}"`);
  }
  if (ln.distance !== undefined) {
    attrs.push(`w:distance="${intAttr(ln.distance)}"`);
  }
  if (ln.restart) {
    attrs.push(`w:restart="${ln.restart}"`);
  }
  return attrs.length > 0 ? `<w:lnNumType ${attrs.join(" ")}/>` : "";
}

function serializePageNumbering(props: SectionProperties): string {
  if (!props.pageNumbering) {
    return "";
  }

  const attrs: string[] = [];
  const pageNumbering = props.pageNumbering;
  if (pageNumbering.format) {
    attrs.push(`w:fmt="${pageNumbering.format}"`);
  }
  if (pageNumbering.start !== undefined) {
    attrs.push(`w:start="${intAttr(pageNumbering.start)}"`);
  }
  if (pageNumbering.chapterStyle !== undefined) {
    attrs.push(`w:chapStyle="${intAttr(pageNumbering.chapterStyle)}"`);
  }
  if (pageNumbering.chapterSeparator) {
    attrs.push(`w:chapSep="${pageNumbering.chapterSeparator}"`);
  }

  return attrs.length > 0 ? `<w:pgNumType ${attrs.join(" ")}/>` : "";
}

function serializePageBorders(props: SectionProperties): string {
  if (!props.pageBorders) {
    return "";
  }

  const attrs: string[] = [];
  const borderElements: string[] = [];
  const pb = props.pageBorders;
  if (pb.display) {
    attrs.push(`w:display="${pb.display}"`);
  }
  if (pb.offsetFrom) {
    attrs.push(`w:offsetFrom="${pb.offsetFrom}"`);
  }
  if (pb.zOrder) {
    attrs.push(`w:zOrder="${pb.zOrder}"`);
  }

  for (const [key, elementName] of [
    ["top", "top"],
    ["left", "left"],
    ["bottom", "bottom"],
    ["right", "right"],
  ] as const) {
    const xml = serializeBorder(pb[key], elementName);
    if (xml) {
      borderElements.push(xml);
    }
  }

  if (borderElements.length === 0) {
    return "";
  }

  const attrsStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  return `<w:pgBorders${attrsStr}>${borderElements.join("")}</w:pgBorders>`;
}

function serializeBackground(props: SectionProperties): string {
  if (!props.background) {
    return "";
  }

  const attrs: string[] = [];
  const { background } = props;
  if (background.color?.auto) {
    attrs.push('w:color="auto"');
  } else if (background.color?.rgb) {
    attrs.push(`w:color="${background.color.rgb}"`);
  }
  if (background.themeColor ?? background.color?.themeColor) {
    attrs.push(
      `w:themeColor="${background.themeColor ?? background.color?.themeColor}"`,
    );
  }
  if (background.themeTint ?? background.color?.themeTint) {
    attrs.push(
      `w:themeTint="${background.themeTint ?? background.color?.themeTint}"`,
    );
  }
  if (background.themeShade ?? background.color?.themeShade) {
    attrs.push(
      `w:themeShade="${background.themeShade ?? background.color?.themeShade}"`,
    );
  }

  return attrs.length > 0 ? `<w:background ${attrs.join(" ")}/>` : "";
}

function serializeDocGrid(props: SectionProperties): string {
  if (!props.docGrid) {
    return "";
  }

  const attrs: string[] = [];
  const dg = props.docGrid;
  if (dg.type) {
    attrs.push(`w:type="${dg.type}"`);
  }
  if (dg.linePitch !== undefined) {
    attrs.push(`w:linePitch="${intAttr(dg.linePitch)}"`);
  }
  if (dg.charSpace !== undefined) {
    attrs.push(`w:charSpace="${intAttr(dg.charSpace)}"`);
  }
  return attrs.length > 0 ? `<w:docGrid ${attrs.join(" ")}/>` : "";
}

function serializeOnOffElement(
  value: boolean | undefined,
  name: string,
): string {
  if (value === undefined) {
    return "";
  }
  return value ? `<w:${name}/>` : `<w:${name} w:val="0"/>`;
}

export function serializeSectionProperties(
  props: SectionProperties | undefined,
): string {
  if (!props) {
    return "";
  }

  const parts: string[] = [];
  for (const ref of props.headerReferences ?? []) {
    parts.push(serializeHeaderReference(ref));
  }
  for (const ref of props.footerReferences ?? []) {
    parts.push(serializeFooterReference(ref));
  }

  const footnotePrXml = serializeFootnoteProperties(props.footnotePr);
  if (footnotePrXml) {
    parts.push(footnotePrXml);
  }

  const endnotePrXml = serializeEndnoteProperties(props.endnotePr);
  if (endnotePrXml) {
    parts.push(endnotePrXml);
  }

  if (props.sectionStart) {
    parts.push(`<w:type w:val="${props.sectionStart}"/>`);
  }

  for (const xml of [
    serializePageSize(props),
    serializePageMargins(props),
    serializePaperSource(props),
    serializePageBorders(props),
    serializeBackground(props),
    serializeLineNumbers(props),
    serializePageNumbering(props),
    serializeColumns(props),
    serializeDocGrid(props),
  ]) {
    if (xml) {
      parts.push(xml);
    }
  }

  if (props.verticalAlign) {
    parts.push(`<w:vAlign w:val="${props.verticalAlign}"/>`);
  }
  if (props.textDirection) {
    parts.push(`<w:textDirection w:val="${props.textDirection}"/>`);
  }
  if (props.titlePg) {
    parts.push("<w:titlePg/>");
  }
  if (props.bidi) {
    parts.push("<w:bidi/>");
  }
  for (const xml of [
    serializeOnOffElement(props.formProtection, "formProt"),
    serializeOnOffElement(props.noEndnote, "noEndnote"),
    serializeOnOffElement(props.rtlGutter, "rtlGutter"),
  ]) {
    if (xml) {
      parts.push(xml);
    }
  }
  if (props.printerSettingsRelationshipId) {
    parts.push(
      `<w:printerSettings r:id="${props.printerSettingsRelationshipId}"/>`,
    );
  }

  const unserializedChildNames =
    getUnserializedSectionPropertyChildNames(props);
  if (unserializedChildNames && unserializedChildNames.length > 0) {
    return "";
  }

  if (parts.length > 0) {
    return `<w:sectPr>${parts.join("")}</w:sectPr>`;
  }

  if (Object.keys(props).length > 0) {
    return "";
  }

  // Empty `<w:sectPr/>` is meaningful in OOXML: as a paragraph-level child it
  // marks a mid-body section break that inherits all settings from the following
  // section. Only use that fallback for truly empty section properties; if the
  // parser saw unparsed children, keep returning "" so the package fidelity
  // guard fails closed instead of silently dropping those settings.
  return "<w:sectPr/>";
}
