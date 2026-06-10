/**
 * ProseMirror to Document Conversion
 *
 * Converts a ProseMirror document back to our Document type.
 * This enables round-trip editing: DOCX -> Document -> PM -> Document -> DOCX
 *
 * Key responsibilities:
 * - Coalesce consecutive text with same marks into single Runs
 * - Preserve paragraph attributes (paraId, textId, formatting)
 * - Handle marks -> TextFormatting conversion
 */

import type { Node as PMNode, Mark } from "prosemirror-model";

import { narrowEnum, ShapeOutlineStyleSchema } from "../../docx/parserEnums";
import type {
  ImageWrap,
  ImagePosition,
  ImageTransform,
  ShapeFill,
  ShapeOutline,
  SectionProperties,
  SectionStart,
} from "../../types/content";
import type {
  BlockContent,
  BlockSdt,
  Document,
  DocumentBody,
  Paragraph,
  Run,
  TextFormatting,
  ParagraphFormatting,
  TextContent,
  BreakContent,
  TabContent,
  DrawingContent,
  Image,
  Hyperlink,
  ParagraphContent,
  Table,
  TableRow,
  TableCell,
  TableFormatting,
  TableRowFormatting,
  TableCellFormatting,
  TableBorders,
  ShapeContent,
  Shape,
  NoteReferenceContent,
  SimpleField,
  ComplexField,
  InlineSdt,
  SdtProperties,
  TrackedChangeInfo,
  MathEquation,
  ColorValue,
  CellMargins,
} from "../../types/document";
import {
  OUTLINE_STYLE_CSS_ALIASES,
  type OutlineStyleCssAlias,
} from "../../types/documentEnumValues";
import { pixelsToEmu } from "../../utils/units";
import {
  expectCharacterSpacingMarkAttrs,
  expectCharacterStyleMarkAttrs,
  expectCommentMarkAttrs,
  expectEmphasisMarkAttrs,
  expectTextEffectMarkAttrs,
  expectFieldAttrs,
  expectFontFamilyMarkAttrs,
  expectFontSizeMarkAttrs,
  expectFootnoteRefMarkAttrs,
  expectHardBreakAttrs,
  expectHighlightMarkAttrs,
  expectRunShadingMarkAttrs,
  expectHyperlinkMarkAttrs,
  expectImageAttrs,
  expectMathAttrs,
  expectParagraphAttrs,
  expectRunFormattingOverrideMarkAttrs,
  expectBlockSdtAttrs,
  expectSdtAttrs,
  expectShapeAttrs,
  expectStrikeMarkAttrs,
  expectTableAttrs,
  expectTableCellAttrs,
  expectTableRowAttrs,
  expectTextBoxAttrs,
  expectTextColorMarkAttrs,
  expectTrackedChangeMarkAttrs,
  expectUnderlineMarkAttrs,
} from "../attrs";
import type { RunFormattingOverrideAttrs } from "../schema/marks";
import type {
  ParagraphAttrs,
  TableAttrs,
  TableRowAttrs,
  TableCellAttrs,
  ImagePositionAttrs,
  TextBoxAttrs,
} from "../schema/nodes";
import { assertValidProseMirrorDocument } from "../validation";
import { runShadingAttrsToShading } from "./runShadingMark";

function normalizeShapeOutlineStyle(
  style: string | undefined,
): ShapeOutline["style"] | undefined {
  if (!style) {
    return undefined;
  }
  // Map a folio CSS alias to its OOXML dash style; OOXML values pass through.
  // `"none"` is not an OOXML dash style, so it narrows to undefined here — the
  // serializer's no-outline guard must drop the `<a:ln>` before calling this.
  if (style in OUTLINE_STYLE_CSS_ALIASES) {
    // SAFETY: the `in` check narrows `style` to a CSS-alias key.
    return OUTLINE_STYLE_CSS_ALIASES[style as OutlineStyleCssAlias];
  }
  return narrowEnum(style, ShapeOutlineStyleSchema);
}

function parseTransformAttr(
  transformStr: string | undefined,
): ImageTransform | undefined {
  if (!transformStr) {
    return undefined;
  }
  const transform: ImageTransform = {};
  const rotateMatch = /rotate\(([-\d.]+)deg\)/u.exec(transformStr);
  if (rotateMatch) {
    const rotation = Number.parseFloat(rotateMatch[1]!);
    if (Number.isFinite(rotation)) {
      transform.rotation = rotation;
    }
  }
  if (transformStr.includes("scaleX(-1)")) {
    transform.flipH = true;
  }
  if (transformStr.includes("scaleY(-1)")) {
    transform.flipV = true;
  }
  if (
    transform.rotation === undefined &&
    !transform.flipH &&
    !transform.flipV
  ) {
    return undefined;
  }
  return transform;
}

function imagePositionFromAttrs(
  attrs: ImagePositionAttrs | undefined,
): ImagePosition | undefined {
  const horizontalPosition = attrs?.horizontal;
  const verticalPosition = attrs?.vertical;
  if (!horizontalPosition || !verticalPosition) {
    return undefined;
  }

  const horizontal: ImagePosition["horizontal"] = {
    relativeTo: horizontalPosition.relativeTo || "column",
  };
  if (horizontalPosition.align) {
    horizontal.alignment = horizontalPosition.align;
  }
  if (horizontalPosition.posOffset !== undefined) {
    horizontal.posOffset = horizontalPosition.posOffset;
  }

  const vertical: ImagePosition["vertical"] = {
    relativeTo: verticalPosition.relativeTo || "paragraph",
  };
  if (verticalPosition.align) {
    vertical.alignment = verticalPosition.align;
  }
  if (verticalPosition.posOffset !== undefined) {
    vertical.posOffset = verticalPosition.posOffset;
  }

  return { horizontal, vertical };
}

function textBoxWrapFromAttrs(attrs: TextBoxAttrs): ImageWrap | undefined {
  const hasWrapData =
    (attrs.wrapType !== undefined && attrs.wrapType !== "inline") ||
    attrs.wrapText !== undefined ||
    attrs.distTop !== undefined ||
    attrs.distBottom !== undefined ||
    attrs.distLeft !== undefined ||
    attrs.distRight !== undefined;
  if (!hasWrapData) {
    return undefined;
  }

  const wrap: ImageWrap = { type: attrs.wrapType ?? "inline" };
  if (attrs.wrapText !== undefined) {
    wrap.wrapText = attrs.wrapText;
  }
  if (attrs.distTop !== undefined) {
    wrap.distT = pixelsToEmu(attrs.distTop);
  }
  if (attrs.distBottom !== undefined) {
    wrap.distB = pixelsToEmu(attrs.distBottom);
  }
  if (attrs.distLeft !== undefined) {
    wrap.distL = pixelsToEmu(attrs.distLeft);
  }
  if (attrs.distRight !== undefined) {
    wrap.distR = pixelsToEmu(attrs.distRight);
  }
  return wrap;
}

/**
 * Convert a ProseMirror document to our Document type
 */
export function fromProseDoc(pmDoc: PMNode, baseDocument?: Document): Document {
  assertValidProseMirrorDocument(
    pmDoc,
    "Cannot convert invalid ProseMirror document to DOCX model",
  );

  const blocks = extractBlocks(pmDoc);

  // Preserve section properties (margins, headers, footers) from base document
  const documentBody: DocumentBody = { content: blocks };
  if (baseDocument?.package.document.finalSectionProperties) {
    documentBody.finalSectionProperties =
      baseDocument.package.document.finalSectionProperties;
  }
  if (baseDocument?.package.document.sections) {
    documentBody.sections = baseDocument.package.document.sections;
  }
  if (baseDocument?.package.document.comments) {
    documentBody.comments = baseDocument.package.document.comments;
  }

  // If we have a base document, preserve its package structure
  if (baseDocument) {
    return {
      ...baseDocument,
      package: {
        ...baseDocument.package,
        document: documentBody,
      },
    };
  }

  // Create a minimal document structure
  return {
    package: {
      document: documentBody,
    },
  };
}

/**
 * Extract block content (paragraphs, tables, block SDTs) from a ProseMirror
 * document.
 */
function extractBlocks(pmDoc: PMNode): BlockContent[] {
  const blocks: BlockContent[] = [];
  const documentCounts = buildDocumentTrackedChangeCounts(pmDoc);
  let pendingPageBreaks = 0;
  let previousStandaloneTextBox: PreviousStandaloneTextBox | null = null;

  const flushPendingPageBreaks = (): void => {
    for (let index = 0; index < pendingPageBreaks; index += 1) {
      blocks.push(createPageBreakParagraph());
    }
    pendingPageBreaks = 0;
  };
  const appendPendingPageBreaksToPreviousParagraph = (): boolean => {
    const previousBlock = blocks.at(-1);
    if (previousBlock?.type !== "paragraph") {
      return false;
    }
    appendPageBreaks(previousBlock, pendingPageBreaks);
    pendingPageBreaks = 0;
    return true;
  };

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  pmDoc.forEach((node) => {
    if (node.type.name === "pageBreak") {
      pendingPageBreaks += 1;
      previousStandaloneTextBox = null;
      return;
    }

    if (node.type.name === "paragraph") {
      const paragraph = convertPMParagraph(node, documentCounts);
      prependPageBreaks(paragraph, pendingPageBreaks);
      pendingPageBreaks = 0;
      blocks.push(paragraph);
      previousStandaloneTextBox = null;
    } else if (node.type.name === "table") {
      if (
        pendingPageBreaks > 0 &&
        !appendPendingPageBreaksToPreviousParagraph()
      ) {
        flushPendingPageBreaks();
      }
      blocks.push(convertPMTable(node, documentCounts));
      previousStandaloneTextBox = null;
    } else if (node.type.name === "textBox") {
      previousStandaloneTextBox = appendTextBoxBlock(blocks, node, {
        pendingPageBreaks,
        previousStandaloneTextBox,
      });
      pendingPageBreaks = 0;
    } else if (node.type.name === "blockSdt") {
      if (
        pendingPageBreaks > 0 &&
        !appendPendingPageBreaksToPreviousParagraph()
      ) {
        flushPendingPageBreaks();
      }
      blocks.push(convertPMBlockSdt(node));
      previousStandaloneTextBox = null;
    }
  });

  if (pendingPageBreaks > 0 && !appendPendingPageBreaksToPreviousParagraph()) {
    flushPendingPageBreaks();
  }

  return blocks;
}

type AppendTextBoxBlockOptions = {
  pendingPageBreaks: number;
  previousStandaloneTextBox: PreviousStandaloneTextBox | null;
};

type PreviousStandaloneTextBox = {
  paragraph: Paragraph;
  groupId: string;
};

function convertPMBlockSdt(node: PMNode): BlockSdt {
  const attrs = expectBlockSdtAttrs(node);
  const properties: SdtProperties = { sdtType: attrs.sdtType };
  if (attrs.alias) {
    properties.alias = attrs.alias;
  }
  if (attrs.tag) {
    properties.tag = attrs.tag;
  }
  if (typeof attrs.id === "number") {
    properties.id = attrs.id;
  }
  if (attrs.lock) {
    properties.lock = attrs.lock;
  }
  if (attrs.placeholder) {
    properties.placeholder = attrs.placeholder;
  }
  // Preserve the explicit boolean — including `false`. When the widget
  // / editor-ref path fills a placeholder-bearing control,
  // `replaceBlockSdtChildren` sets `showingPlaceholder: false` so the
  // serializer's `reconcileRawSdtPr` knows to remove the source DOCX's
  // `<w:showingPlcHdr/>`. A truthy-only check (the prior shape) would
  // drop that `false` and the saved file would keep marking the
  // newly filled body as placeholder text.
  if (attrs.showingPlaceholder !== undefined) {
    properties.showingPlaceholder = attrs.showingPlaceholder;
  }
  if (attrs.dateFormat) {
    properties.dateFormat = attrs.dateFormat;
  }
  if (attrs.dateValueISO) {
    properties.dateValueISO = attrs.dateValueISO;
  }
  if (attrs.listItems) {
    const items = parseListItemsJson(attrs.listItems);
    if (items) {
      properties.listItems = items;
    }
  }
  if (typeof attrs.dropdownLastValue === "string") {
    properties.dropdownLastValue = attrs.dropdownLastValue;
  }
  if (typeof attrs.checked === "boolean") {
    properties.checked = attrs.checked;
  }
  if (attrs.rawPropertiesXml) {
    properties.rawPropertiesXml = attrs.rawPropertiesXml;
  }
  if (attrs.rawEndPropertiesXml) {
    properties.rawEndPropertiesXml = attrs.rawEndPropertiesXml;
  }
  if (attrs.rawSdtChildrenBeforeContent) {
    properties.rawSdtChildrenBeforeContent = attrs.rawSdtChildrenBeforeContent;
  }
  if (attrs.rawSdtChildrenAfterContent) {
    properties.rawSdtChildrenAfterContent = attrs.rawSdtChildrenAfterContent;
  }

  // Recursively materialize children. PM `blockSdt` content is `block+`, so a
  // mini-doc node is a convenient way to reuse extractBlocks.
  const innerDoc = node.type.schema.node("doc", null, node.content);
  const extracted = extractBlocks(innerDoc);

  // `toProseDoc` inserts a synthetic filler paragraph into any blockSdt
  // whose source had an empty `<w:sdtContent/>` and stamps the
  // `_originallyEmpty` marker on the PM node. Use that explicit marker
  // (not a shape heuristic) to drop the filler on save — an authored
  // `<w:sdtContent><w:p/></w:sdtContent>` does NOT carry the marker
  // and its empty paragraph survives the round trip intact. If the
  // user typed into the filler we still preserve the paragraph,
  // matching their intent.
  const wasOriginallyEmpty = attrs._originallyEmpty === true;
  const content =
    wasOriginallyEmpty && isStillSyntheticFiller(extracted) ? [] : extracted;

  return { type: "blockSdt", properties, content };
}

function isStillSyntheticFiller(blocks: BlockContent[]): boolean {
  if (blocks.length !== 1) {
    return false;
  }
  const block = blocks[0];
  if (!block || block.type !== "paragraph") {
    return false;
  }
  if (block.content.length !== 0) {
    return false;
  }
  // Reject anything that signals real editing (formatting, mark changes,
  // section properties) — if the user authored content, preserve it.
  if (block.formatting !== undefined) {
    return false;
  }
  if (block.sectionProperties !== undefined) {
    return false;
  }
  if (block.propertyChanges !== undefined) {
    return false;
  }
  if (block.pPrMark !== undefined) {
    return false;
  }
  return true;
}

function parseListItemsJson(
  raw: string,
): { displayText: string; value: string }[] | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const items: { displayText: string; value: string }[] = [];
    for (const entry of parsed) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        "displayText" in entry &&
        "value" in entry &&
        typeof (entry as { displayText: unknown }).displayText === "string" &&
        typeof (entry as { value: unknown }).value === "string"
      ) {
        items.push(entry as { displayText: string; value: string });
      }
    }
    return items.length > 0 ? items : undefined;
  } catch {
    return undefined;
  }
}

function appendTextBoxBlock(
  blocks: BlockContent[],
  node: PMNode,
  options: AppendTextBoxBlockOptions,
): PreviousStandaloneTextBox | null {
  const attrs = expectTextBoxAttrs(node);
  const paragraph = convertPMTextBox(node);
  const previousBlock = blocks.at(-1);
  if (
    attrs._docxPlacement === "inlineWithPrevious" &&
    previousBlock?.type === "paragraph"
  ) {
    appendPageBreaks(previousBlock, options.pendingPageBreaks);
    previousBlock.content.push(...paragraph.content);
    return null;
  }

  if (
    attrs._docxPlacement === "standalone" &&
    attrs._docxGroupId &&
    options.previousStandaloneTextBox?.groupId === attrs._docxGroupId
  ) {
    options.previousStandaloneTextBox.paragraph.content.push(
      ...paragraph.content,
    );
    return options.previousStandaloneTextBox;
  }

  prependPageBreaks(paragraph, options.pendingPageBreaks);
  blocks.push(paragraph);
  return attrs._docxPlacement === "standalone" && attrs._docxGroupId
    ? { paragraph, groupId: attrs._docxGroupId }
    : null;
}

/**
 * Inverse of toProseDoc's listRendering → list* attrs flattening. Markdown
 * export (`toMarkdown`) and re-layout of the rebuilt Document key off
 * `paragraph.listRendering`; without this, every edited document loses its
 * list markers on the way out of the editor.
 */
function listRenderingFromAttrs(
  attrs: ParagraphAttrs,
): Paragraph["listRendering"] {
  const numId = attrs.numPr?.numId;
  if (numId === undefined || numId === 0) {
    return undefined;
  }
  const hasRenderingInfo =
    attrs.listMarker != null || attrs.listIsBullet || attrs.listNumFmt != null;
  if (!hasRenderingInfo) {
    return undefined;
  }
  return {
    marker: attrs.listMarker ?? "",
    level: attrs.numPr?.ilvl ?? 0,
    numId,
    isBullet: attrs.listIsBullet ?? false,
    ...(attrs.listIsLegal != null && { isLegal: attrs.listIsLegal }),
    ...(attrs.listNumFmt != null && { numFmt: attrs.listNumFmt }),
    ...(attrs.listMarkerHidden != null && {
      markerHidden: attrs.listMarkerHidden,
    }),
    ...(attrs.listMarkerFontFamily != null && {
      markerFontFamily: attrs.listMarkerFontFamily,
    }),
    ...(attrs.listMarkerFontSize != null && {
      markerFontSize: attrs.listMarkerFontSize,
    }),
    ...(attrs.listMarkerSuffix != null && {
      markerSuffix: attrs.listMarkerSuffix,
    }),
    ...(attrs.listMarkerAllCaps != null && {
      markerAllCaps: attrs.listMarkerAllCaps,
    }),
    ...(attrs.listImplicitChildLevelAdvances != null && {
      implicitChildLevelAdvances: attrs.listImplicitChildLevelAdvances,
    }),
    ...(attrs.listMarkerSecondSlotOffsetTwips != null && {
      markerSecondSlotOffsetTwips: attrs.listMarkerSecondSlotOffsetTwips,
    }),
    ...(attrs.listLevelNumFmts != null && {
      levelNumFmts: attrs.listLevelNumFmts,
    }),
    ...(attrs.listAbstractNumId != null && {
      abstractNumId: attrs.listAbstractNumId,
    }),
    ...(attrs.listStartOverride != null && {
      startOverride: attrs.listStartOverride,
    }),
  };
}

/**
 * Create a paragraph containing only a page break run (for DOCX serialization)
 */
function createPageBreakParagraph(): Paragraph {
  const breakContent: BreakContent = { type: "break", breakType: "page" };
  const run: Run = { type: "run", content: [breakContent] };
  return {
    type: "paragraph",
    content: [run],
  };
}

function createPageBreakRun(): Run {
  return {
    type: "run",
    content: [{ type: "break", breakType: "page" }],
  };
}

function prependPageBreaks(paragraph: Paragraph, count: number): void {
  for (let index = 0; index < count; index += 1) {
    paragraph.content.unshift(createPageBreakRun());
  }
}

function appendPageBreaks(paragraph: Paragraph, count: number): void {
  for (let index = 0; index < count; index += 1) {
    paragraph.content.push(createPageBreakRun());
  }
}

/**
 * Convert a ProseMirror paragraph node to our Paragraph type
 */
function convertPMParagraph(
  node: PMNode,
  documentCounts?: TrackedChangeCounts,
): Paragraph {
  const attrs = expectParagraphAttrs(node);
  let content = extractParagraphContent(
    node,
    documentCounts,
    attrs._emptyHyperlinks ?? undefined,
  );

  // Emit BookmarkStart/End from bookmarks attr (for TOC anchors, cross-references)
  const bookmarks = attrs.bookmarks as
    | { id: number; name: string }[]
    | undefined;
  if (bookmarks && bookmarks.length > 0) {
    const starts: ParagraphContent[] = bookmarks.map((b) => ({
      type: "bookmarkStart" as const,
      id: b.id,
      name: b.name,
    }));
    const ends: ParagraphContent[] = bookmarks.map((b) => ({
      type: "bookmarkEnd" as const,
      id: b.id,
    }));
    content = [...starts, ...content, ...ends];
  }

  const paragraph: Paragraph = {
    type: "paragraph",
    content,
  };
  if (attrs.paraId) {
    paragraph.paraId = attrs.paraId;
  }
  if (attrs.textId) {
    paragraph.textId = attrs.textId;
  }
  const pFormatting = paragraphAttrsToFormatting(attrs);
  if (pFormatting) {
    paragraph.formatting = pFormatting;
  }
  const listRendering = listRenderingFromAttrs(attrs);
  if (listRendering) {
    paragraph.listRendering = listRendering;
  }
  if (attrs.renderedPageBreakBefore) {
    paragraph.renderedPageBreakBefore = true;
  }

  // Restore full section properties (round-trip) or fallback to break type only
  if (attrs._sectionProperties) {
    paragraph.sectionProperties = attrs._sectionProperties as SectionProperties;
  } else if (attrs.sectionBreakType) {
    paragraph.sectionProperties = {
      sectionStart: attrs.sectionBreakType as SectionStart,
    };
  }

  // Restore `w:pPrChange` entries that PM carried opaquely. The editor
  // doesn't surface them in UI, but they must survive an edit so the
  // saved DOCX still contains the property-change history Word relies
  // on. Shallow-clone the array so the rebuilt Folio document doesn't
  // share a mutable reference with PM's attrs.
  if (
    Array.isArray(attrs._propertyChanges) &&
    attrs._propertyChanges.length > 0
  ) {
    paragraph.propertyChanges = [...attrs._propertyChanges];
  }

  if (attrs.pPrMark) {
    paragraph.pPrMark = attrs.pPrMark;
  }

  return paragraph;
}

function paragraphAttrsToFormatting(
  attrs: ParagraphAttrs,
): ParagraphFormatting | undefined {
  // If we have the original inline formatting from the DOCX, use it as a base
  // for lossless round-trip. This preserves properties like contextualSpacing,
  // widowControl, beforeAutospacing, runProperties, etc. that aren't tracked
  // as individual PM attrs. It also avoids "inlining" style-inherited values
  // (spacing, indentation, numPr) which would override style definitions
  // and break rendering in Word/Pages/Google Docs.
  //
  // We then apply overrides for any properties the user may have changed
  // via editor commands (alignment, list toggle, etc.).
  if (attrs._originalFormatting) {
    const orig = attrs._originalFormatting;
    const result = { ...orig };

    // Override properties that user may have changed via editor commands.
    // Only override if the PM attr differs from the original value.
    if (attrs.alignment !== (orig.alignment ?? undefined)) {
      if (attrs.alignment) {
        result.alignment = attrs.alignment;
      } else {
        delete result.alignment;
      }
    }
    if (
      attrs.numPr !== orig.numPr &&
      JSON.stringify(attrs.numPr) !== JSON.stringify(orig.numPr)
    ) {
      if (attrs.numPr) {
        result.numPr = attrs.numPr;
      } else {
        delete result.numPr;
      }
    }
    if (attrs.styleId !== (orig.styleId ?? undefined)) {
      if (attrs.styleId) {
        result.styleId = attrs.styleId;
      } else {
        delete result.styleId;
      }
    }
    if (attrs.pageBreakBefore !== (orig.pageBreakBefore ?? undefined)) {
      if (attrs.pageBreakBefore) {
        result.pageBreakBefore = attrs.pageBreakBefore;
      } else {
        delete result.pageBreakBefore;
      }
    }
    if (attrs.spacingExplicit !== orig.spacingExplicit) {
      if (attrs.spacingExplicit) {
        result.spacingExplicit = attrs.spacingExplicit;
      } else {
        delete result.spacingExplicit;
      }
    }
    if (attrs.bidi !== (orig.bidi ?? undefined)) {
      if (attrs.bidi) {
        result.bidi = attrs.bidi;
      } else {
        delete result.bidi;
      }
    }

    return result;
  }

  // Fallback: reconstruct formatting from individual attrs (e.g. for
  // newly created paragraphs that don't have _originalFormatting)
  const outlineLevel = Reflect.get(attrs, "outlineLevel");
  const hasFormatting =
    attrs.alignment ||
    attrs.spaceBefore ||
    attrs.spaceAfter ||
    attrs.lineSpacing ||
    attrs.indentLeft ||
    attrs.indentRight ||
    attrs.indentFirstLine ||
    attrs.numPr ||
    attrs.styleId ||
    attrs.borders ||
    attrs.shading ||
    attrs.tabs ||
    typeof outlineLevel === "number" ||
    attrs.contextualSpacing ||
    attrs.spacingExplicit ||
    attrs.bidi;

  if (!hasFormatting) {
    return undefined;
  }

  const f: ParagraphFormatting = {};
  if (attrs.alignment) {
    f.alignment = attrs.alignment;
  }
  if (attrs.spaceBefore) {
    f.spaceBefore = attrs.spaceBefore;
  }
  if (attrs.spaceAfter) {
    f.spaceAfter = attrs.spaceAfter;
  }
  if (attrs.lineSpacing) {
    f.lineSpacing = attrs.lineSpacing;
  }
  if (attrs.lineSpacingRule) {
    f.lineSpacingRule = attrs.lineSpacingRule;
  }
  if (attrs.spacingExplicit) {
    f.spacingExplicit = attrs.spacingExplicit;
  }
  if (attrs.indentLeft) {
    f.indentLeft = attrs.indentLeft;
  }
  if (attrs.indentRight) {
    f.indentRight = attrs.indentRight;
  }
  if (attrs.indentFirstLine) {
    f.indentFirstLine = attrs.indentFirstLine;
  }
  if (attrs.hangingIndent) {
    f.hangingIndent = attrs.hangingIndent;
  }
  if (attrs.numPr) {
    f.numPr = attrs.numPr;
  }
  if (attrs.styleId) {
    f.styleId = attrs.styleId;
  }
  if (attrs.borders) {
    f.borders = attrs.borders;
  }
  if (attrs.shading) {
    f.shading = attrs.shading;
  }
  if (attrs.tabs) {
    f.tabs = attrs.tabs;
  }
  if (typeof outlineLevel === "number") {
    f.outlineLevel = outlineLevel;
  }
  if (attrs.contextualSpacing) {
    f.contextualSpacing = attrs.contextualSpacing;
  }
  if (attrs.bidi) {
    f.bidi = attrs.bidi;
  }
  return f;
}

/**
 * Extract paragraph content (runs, hyperlinks) from ProseMirror paragraph
 *
 * Coalesces consecutive text with the same marks into single Runs
 * for efficient DOCX representation.
 */
function extractParagraphContent(
  paragraph: PMNode,
  // Parameter retained for signature compatibility with the call sites
  // threaded through tables/cells. The body no longer needs the counts
  // — `moveFrom`/`moveTo` round-trip is now driven by the explicit
  // `moveKind` mark attribute set by `toProseDoc`.
  _documentCounts?: TrackedChangeCounts,
  emptyHyperlinks?: NonNullable<ParagraphAttrs["_emptyHyperlinks"]>,
): ParagraphContent[] {
  const content: ParagraphContent[] = [];
  const sortedEmptyHyperlinks = (emptyHyperlinks ?? [])
    .map((attrs, order) => ({ attrs, order }))
    .toSorted(
      (left, right) =>
        left.attrs.offset - right.attrs.offset || left.order - right.order,
    );
  let nextEmptyHyperlink = 0;

  // Track current run being built
  let currentRun: Run | null = null;
  let currentMarksKey: string | null = null;
  let currentHyperlink: Hyperlink | null = null;
  let currentHyperlinkKey: string | null = null;
  const openedComments = new Set<number>();

  const flushCurrentInline = () => {
    if (currentRun) {
      content.push(currentRun);
      currentRun = null;
      currentMarksKey = null;
    }
    if (currentHyperlink) {
      content.push(currentHyperlink);
      currentHyperlink = null;
      currentHyperlinkKey = null;
    }
  };

  const syncCommentRanges = (node: PMNode) => {
    const nodeCommentIds = getCommentMarkIds(node.marks);
    let changed = false;
    for (const commentId of openedComments) {
      if (!nodeCommentIds.has(commentId)) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      for (const commentId of nodeCommentIds) {
        if (!openedComments.has(commentId)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) {
      return;
    }

    flushCurrentInline();

    for (const commentId of [...openedComments]) {
      if (!nodeCommentIds.has(commentId)) {
        content.push({ type: "commentRangeEnd", id: commentId });
        openedComments.delete(commentId);
      }
    }

    for (const commentId of nodeCommentIds) {
      if (!openedComments.has(commentId)) {
        content.push({ type: "commentRangeStart", id: commentId });
        openedComments.add(commentId);
      }
    }
  };

  const flushEmptyHyperlinksThroughOffset = (offset: number): void => {
    while (nextEmptyHyperlink < sortedEmptyHyperlinks.length) {
      const item = sortedEmptyHyperlinks[nextEmptyHyperlink];
      if (!item || item.attrs.offset > offset) {
        break;
      }
      nextEmptyHyperlink += 1;
      flushCurrentInline();
      content.push(createEmptyHyperlink(item.attrs));
    }
  };

  const processInlineNode = (node: PMNode): void => {
    syncCommentRanges(node);
    const linkMark = node.marks.find((m) => m.type.name === "hyperlink");

    // Check for footnote/endnote reference mark
    const noteRefMark = node.marks.find((m) => m.type.name === "footnoteRef");
    if (noteRefMark && !linkMark) {
      // Finish any current content
      flushCurrentInline();
      content.push(createNoteReferenceRun(noteRefMark));
      return;
    }

    // Check for tracked change marks (insertion/deletion)
    const insertionMark = node.marks.find((m) => m.type.name === "insertion");
    const deletionMark = node.marks.find((m) => m.type.name === "deletion");
    if (insertionMark || deletionMark) {
      // Finish any current content
      flushCurrentInline();

      const changeMark = insertionMark ?? deletionMark;
      if (!changeMark) {
        return;
      }
      const changeAttrs = expectTrackedChangeMarkAttrs(changeMark);
      // Filter out the tracked change mark for text formatting extraction
      const otherMarks = node.marks.filter(
        (m) => m.type.name !== "insertion" && m.type.name !== "deletion",
      );
      const run = createTrackedChangeRun(node, otherMarks);
      if (!run) {
        return;
      }

      const info: TrackedChangeInfo = {
        id: changeAttrs.revisionId,
        author: changeAttrs.author || "Unknown",
      };
      if (changeAttrs.date) {
        info.date = changeAttrs.date;
      }
      // The mark itself records whether it originated as a
      // `w:moveTo` / `w:moveFrom`. The previous "is there both an
      // insertion AND a deletion with the same revisionId somewhere
      // in the document?" heuristic was unsound: OOXML doesn't
      // require `w:moveFrom`/`w:moveTo` to share `w:id` (they
      // typically don't), and unrelated `w:ins w:id="5"` /
      // `w:del w:id="5"` from different reviewers would coincidentally
      // fuse into a phantom move pair.
      if (insertionMark) {
        if (changeAttrs.moveKind === "moveTo") {
          content.push({ type: "moveTo", info, content: [run] });
        } else {
          content.push({ type: "insertion", info, content: [run] });
        }
      } else if (changeAttrs.moveKind === "moveFrom") {
        content.push({ type: "moveFrom", info, content: [run] });
      } else {
        content.push({ type: "deletion", info, content: [run] });
      }
      return;
    }

    if (linkMark) {
      // Start or continue hyperlink
      const linkKey = getLinkKey(linkMark);

      if (currentHyperlink && currentHyperlinkKey === linkKey) {
        // Continue current hyperlink
        addNodeToHyperlink(currentHyperlink, node);
      } else {
        // Finish previous content
        flushCurrentInline();

        // Start new hyperlink
        currentHyperlink = createHyperlink(linkMark);
        currentHyperlinkKey = linkKey;
        addNodeToHyperlink(currentHyperlink, node);
      }
      return;
    }

    // Not in hyperlink - finish any current hyperlink
    if (currentHyperlink) {
      flushCurrentInline();
    }

    // Handle node types
    if (node.isText) {
      const marksKey = getMarksKey(node.marks);

      if (currentRun && currentMarksKey === marksKey) {
        // Append to current run
        appendTextToRun(currentRun, node.text || "");
      } else {
        // Start new run
        if (currentRun) {
          content.push(currentRun);
        }
        currentRun = createRunFromText(node.text || "", node.marks);
        currentMarksKey = marksKey;
      }
    } else if (node.type.name === "hardBreak") {
      // Hard break ends current run
      flushCurrentInline();
      content.push(createBreakRun(readHardBreakType(node)));
    } else if (node.type.name === "image") {
      // Image ends current run
      flushCurrentInline();
      content.push(createImageRun(node));
    } else if (node.type.name === "shape") {
      // Shape ends current run
      flushCurrentInline();
      content.push(createShapeRun(node));
    } else if (node.type.name === "tab") {
      // Tab ends current run
      flushCurrentInline();
      content.push(createTabRun());
    } else if (node.type.name === "field") {
      // Field ends current run and emits a field content item
      flushCurrentInline();
      content.push(createFieldFromNode(node, node.marks));
    } else if (node.type.name === "sdt") {
      // SDT ends current run and emits an InlineSdt content item
      flushCurrentInline();
      content.push(createInlineSdtFromNode(node));
    } else if (node.type.name === "math") {
      // Math ends current run and emits a MathEquation content item
      flushCurrentInline();
      content.push(createMathFromNode(node));
    }
  };

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  paragraph.forEach((node, offset) => {
    flushEmptyHyperlinksThroughOffset(offset);

    if (node.isText && node.text) {
      let consumed = 0;
      const textEndOffset = offset + node.nodeSize;
      while (nextEmptyHyperlink < sortedEmptyHyperlinks.length) {
        const item = sortedEmptyHyperlinks[nextEmptyHyperlink];
        if (!item || item.attrs.offset >= textEndOffset) {
          break;
        }

        const splitOffset = Math.max(item.attrs.offset - offset, consumed);
        const segment = node.text.slice(consumed, splitOffset);
        if (segment) {
          processInlineNode(node.type.schema.text(segment, node.marks));
        }
        flushCurrentInline();
        content.push(createEmptyHyperlink(item.attrs));
        nextEmptyHyperlink += 1;
        consumed = splitOffset;
      }

      const remainder = node.text.slice(consumed);
      if (remainder) {
        processInlineNode(node.type.schema.text(remainder, node.marks));
      }
      return;
    }

    processInlineNode(node);
  });

  flushEmptyHyperlinksThroughOffset(Number.POSITIVE_INFINITY);

  // Don't forget the last run/hyperlink
  flushCurrentInline();
  for (const commentId of openedComments) {
    content.push({ type: "commentRangeEnd", id: commentId });
  }

  return content;
}

function createTrackedChangeRun(
  node: PMNode,
  marks: readonly Mark[],
): Run | null {
  if (node.isText) {
    const formatting = marksToTextFormatting(marks);
    return {
      type: "run",
      content: node.text ? [{ type: "text", text: node.text }] : [],
      ...(Object.keys(formatting).length > 0 ? { formatting } : {}),
    };
  }
  if (node.type.name === "hardBreak") {
    return createBreakRun(readHardBreakType(node));
  }
  if (node.type.name === "image") {
    return createImageRun(node);
  }
  if (node.type.name === "shape") {
    return createShapeRun(node);
  }
  if (node.type.name === "tab") {
    return createTabRun();
  }
  return null;
}

function createEmptyHyperlink(
  attrs: NonNullable<ParagraphAttrs["_emptyHyperlinks"]>[number],
): Hyperlink {
  const hyperlink: Hyperlink = { type: "hyperlink", children: [] };
  if (attrs.href !== undefined) {
    hyperlink.href = attrs.href;
  }
  if (attrs.anchor !== undefined) {
    hyperlink.anchor = attrs.anchor;
  }
  if (attrs.tooltip !== undefined) {
    hyperlink.tooltip = attrs.tooltip;
  }
  if (attrs.rId !== undefined) {
    hyperlink.rId = attrs.rId;
  }
  return hyperlink;
}

function getCommentMarkIds(marks: readonly Mark[]): Set<number> {
  const commentIds = new Set<number>();
  for (const mark of marks) {
    if (mark.type.name === "comment") {
      commentIds.add(expectCommentMarkAttrs(mark).commentId);
    }
  }
  return commentIds;
}

type TrackedChangeCounts = {
  insertionById: Map<number, number>;
  deletionById: Map<number, number>;
};

/**
 * Build document-wide tracked change counts by scanning all nodes.
 * Used for cross-paragraph move pair detection (moveFrom in one paragraph,
 * moveTo in another).
 */
function buildDocumentTrackedChangeCounts(pmDoc: PMNode): TrackedChangeCounts {
  const insertionById = new Map<number, number>();
  const deletionById = new Map<number, number>();

  pmDoc.descendants((node) => {
    const insertionMark = node.marks.find((m) => m.type.name === "insertion");
    const deletionMark = node.marks.find((m) => m.type.name === "deletion");

    if (insertionMark) {
      const { revisionId } = expectTrackedChangeMarkAttrs(insertionMark);
      insertionById.set(revisionId, (insertionById.get(revisionId) ?? 0) + 1);
    }
    if (deletionMark) {
      const { revisionId } = expectTrackedChangeMarkAttrs(deletionMark);
      deletionById.set(revisionId, (deletionById.get(revisionId) ?? 0) + 1);
    }
  });

  return { insertionById, deletionById };
}

/**
 * Create a unique key for a link mark
 */
function getLinkKey(mark: Mark): string {
  const attrs = expectHyperlinkMarkAttrs(mark);
  return [
    attrs.href,
    attrs.rId ?? "",
    attrs.tooltip ?? "",
    attrs._docxHyperlinkIndex ?? "",
  ].join("\u0000");
}

/**
 * Create a unique key for a set of marks (excluding hyperlink)
 */
function getMarksKey(marks: readonly Mark[]): string {
  const nonLinkMarks = marks.filter((m) => m.type.name !== "hyperlink");
  if (nonLinkMarks.length === 0) {
    return "";
  }

  return nonLinkMarks
    .map((m) => `${m.type.name}:${JSON.stringify(m.attrs)}`)
    .toSorted()
    .join("|");
}

/**
 * Create a Hyperlink from a link mark
 */
function createHyperlink(linkMark: Mark): Hyperlink {
  const attrs = expectHyperlinkMarkAttrs(linkMark);
  const href = attrs.href;
  // Internal bookmark links use the anchor property in OOXML
  if (href.startsWith("#")) {
    const hyperlink: Hyperlink = {
      type: "hyperlink",
      anchor: href.slice(1),
      children: [],
    };
    if (attrs.tooltip) {
      hyperlink.tooltip = attrs.tooltip;
    }
    return hyperlink;
  }
  const hyperlink: Hyperlink = {
    type: "hyperlink",
    href,
    children: [],
  };
  if (attrs.tooltip) {
    hyperlink.tooltip = attrs.tooltip;
  }
  if (attrs.rId) {
    hyperlink.rId = attrs.rId;
  }
  return hyperlink;
}

/**
 * Add a node to a hyperlink
 */
function addNodeToHyperlink(hyperlink: Hyperlink, node: PMNode): void {
  const noteRefMark = node.marks.find((m) => m.type.name === "footnoteRef");
  if (noteRefMark) {
    hyperlink.children.push(createNoteReferenceRun(noteRefMark));
    return;
  }

  const nonLinkMarks = node.marks.filter((m) => m.type.name !== "hyperlink");
  if (node.isText && node.text) {
    const run = createRunFromText(node.text, nonLinkMarks);
    hyperlink.children.push(run);
    return;
  }

  if (node.type.name === "hardBreak") {
    hyperlink.children.push(
      createBreakRun(readHardBreakType(node), nonLinkMarks),
    );
    return;
  }

  if (node.type.name === "tab") {
    hyperlink.children.push(createTabRun(nonLinkMarks));
    return;
  }

  if (node.type.name === "image") {
    hyperlink.children.push(createImageRun(node));
    return;
  }

  if (node.type.name === "shape") {
    hyperlink.children.push(createShapeRun(node));
  }
}

function createNoteReferenceRun(noteRefMark: Mark): Run {
  const noteAttrs = expectFootnoteRefMarkAttrs(noteRefMark);
  const noteType =
    noteAttrs.noteType === "endnote" ? "endnoteRef" : "footnoteRef";
  const noteId =
    typeof noteAttrs.id === "string"
      ? Number.parseInt(noteAttrs.id, 10) || 0
      : noteAttrs.id;
  const noteRef: NoteReferenceContent = {
    type: noteType,
    id: noteId,
  };
  return {
    type: "run",
    content: [noteRef],
  };
}

/**
 * Create a Run from text and marks
 */
function createRunFromText(text: string, marks: readonly Mark[]): Run {
  const formatting = getRunFormattingFromMarks(marks);
  const textContent: TextContent = {
    type: "text",
    text,
  };

  const run: Run = { type: "run", content: [textContent] };
  if (formatting) {
    run.formatting = formatting;
  }
  return run;
}

function getRunFormattingFromMarks(
  marks: readonly Mark[] | undefined,
): TextFormatting | undefined {
  if (!marks || marks.length === 0) {
    return undefined;
  }

  const formatting = marksToTextFormatting(marks);
  return Object.keys(formatting).length > 0 ? formatting : undefined;
}

/**
 * Append text to an existing run
 */
function appendTextToRun(run: Run, text: string): void {
  const lastContent = run.content.at(-1);
  if (lastContent && lastContent.type === "text") {
    lastContent.text += text;
  } else {
    run.content.push({ type: "text", text });
  }
}

/**
 * Create a Run containing a line break
 */
function createBreakRun(
  breakType: BreakContent["breakType"] = "textWrapping",
  marks?: readonly Mark[],
): Run {
  const breakContent: BreakContent = {
    type: "break",
    breakType,
  };

  const run: Run = {
    type: "run",
    content: [breakContent],
  };
  const formatting = getRunFormattingFromMarks(marks);
  if (formatting) {
    run.formatting = formatting;
  }
  return run;
}

function readHardBreakType(node: PMNode): BreakContent["breakType"] {
  return expectHardBreakAttrs(node).breakType ?? "textWrapping";
}

/**
 * Create a Run containing a tab
 */
function createTabRun(marks?: readonly Mark[]): Run {
  const tabContent: TabContent = {
    type: "tab",
  };

  const run: Run = {
    type: "run",
    content: [tabContent],
  };
  const formatting = getRunFormattingFromMarks(marks);
  if (formatting) {
    run.formatting = formatting;
  }
  return run;
}

/**
 * Create a SimpleField or ComplexField from a PM field node
 */
function createFieldFromNode(
  node: PMNode,
  marks?: readonly Mark[],
): SimpleField | ComplexField {
  const attrs = expectFieldAttrs(node);

  const formatting =
    marks && marks.length > 0 ? marksToTextFormatting(marks) : undefined;

  // Provide fallback display text for dynamic fields so <w:t> is never empty
  let displayText = attrs.displayText || "";
  if (!displayText) {
    switch (attrs.fieldType) {
      case "PAGE":
        displayText = "1";
        break;
      case "NUMPAGES":
        displayText = "1";
        break;
      default:
        displayText = " ";
        break;
    }
  }

  const displayRun: Run = {
    type: "run",
    content: [{ type: "text" as const, text: displayText }],
    ...(formatting && Object.keys(formatting).length > 0 ? { formatting } : {}),
  };

  if (attrs.fieldKind === "complex") {
    const complex: ComplexField = {
      type: "complexField",
      instruction: attrs.instruction,
      fieldType: attrs.fieldType,
      fieldCode: [],
      fieldResult: [displayRun],
    };
    if (attrs.fldLock) {
      complex.fldLock = true;
    }
    if (attrs.dirty) {
      complex.dirty = true;
    }
    return complex;
  }

  const simple: SimpleField = {
    type: "simpleField",
    instruction: attrs.instruction,
    fieldType: attrs.fieldType,
    content: [displayRun],
  };
  if (attrs.fldLock) {
    simple.fldLock = true;
  }
  if (attrs.dirty) {
    simple.dirty = true;
  }
  return simple;
}

/**
 * Create a MathEquation from a PM math node
 */
function createMathFromNode(node: PMNode): MathEquation {
  const attrs = expectMathAttrs(node);

  const math: MathEquation = {
    type: "mathEquation",
    display: attrs.display ?? "inline",
    ommlXml: attrs.ommlXml,
  };
  if (attrs.plainText) {
    math.plainText = attrs.plainText;
  }
  return math;
}

/**
 * Create an InlineSdt from a PM sdt node
 */
function createInlineSdtFromNode(node: PMNode): InlineSdt {
  const attrs = expectSdtAttrs(node);

  const properties: SdtProperties = {
    sdtType: attrs.sdtType,
  };
  if (attrs.alias) {
    properties.alias = attrs.alias;
  }
  if (attrs.tag) {
    properties.tag = attrs.tag;
  }
  if (attrs.lock) {
    properties.lock = attrs.lock;
  }
  if (attrs.placeholder) {
    properties.placeholder = attrs.placeholder;
  }
  if (attrs.showingPlaceholder !== undefined) {
    properties.showingPlaceholder = attrs.showingPlaceholder;
  }
  if (attrs.dateFormat) {
    properties.dateFormat = attrs.dateFormat;
  }
  if (attrs.dateValueISO) {
    properties.dateValueISO = attrs.dateValueISO;
  }
  if (attrs.listItems) {
    properties.listItems = parseSdtListItems(attrs.listItems);
  }
  if (attrs.checked !== undefined) {
    properties.checked = attrs.checked;
  }

  // Extract content from the sdt node's children. OOXML allows runs,
  // hyperlinks, simple/complex fields, nested SDTs, and math here — keep
  // all of them so docProps-bound fields and similar template content
  // survive a round-trip through the editor. Keep this filter in sync
  // with the exhaustive switch in `serializeInlineSdt`.
  const sdtContent = extractParagraphContent(node);
  const content = sdtContent.filter(
    (c): c is InlineSdt["content"][number] =>
      c.type === "run" ||
      c.type === "hyperlink" ||
      c.type === "simpleField" ||
      c.type === "complexField" ||
      c.type === "inlineSdt" ||
      c.type === "mathEquation",
  );

  return {
    type: "inlineSdt",
    properties,
    content,
  };
}

function parseSdtListItems(
  rawItems: string,
): NonNullable<SdtProperties["listItems"]> {
  const parsed = JSON.parse(rawItems) as unknown;
  if (!Array.isArray(parsed)) {
    throw new TypeError(
      "Invalid ProseMirror sdt attrs: listItems is not an array",
    );
  }

  return parsed.map((item): NonNullable<SdtProperties["listItems"]>[number] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(
        "Invalid ProseMirror sdt attrs: listItems contains an invalid item",
      );
    }
    const itemAttrs = item as { displayText?: unknown; value?: unknown };
    if (
      typeof itemAttrs.displayText !== "string" ||
      typeof itemAttrs.value !== "string"
    ) {
      throw new TypeError(
        "Invalid ProseMirror sdt attrs: listItems contains an invalid item",
      );
    }
    return { displayText: itemAttrs.displayText, value: itemAttrs.value };
  });
}

/**
 * Create a Run containing an image
 */
function createImageRun(node: PMNode): Run {
  const attrs = expectImageAttrs(node);

  // Determine wrap type from attrs (default: inline)
  const wrapType = attrs.wrapType || "inline";

  const wrap: ImageWrap = { type: wrapType };
  if (attrs.distTop !== undefined) {
    wrap.distT = pixelsToEmu(attrs.distTop);
  }
  if (attrs.distBottom !== undefined) {
    wrap.distB = pixelsToEmu(attrs.distBottom);
  }
  if (attrs.distLeft !== undefined) {
    wrap.distL = pixelsToEmu(attrs.distLeft);
  }
  if (attrs.distRight !== undefined) {
    wrap.distR = pixelsToEmu(attrs.distRight);
  }

  // Restore wrapText from PM attr
  if (attrs.wrapText) {
    wrap.wrapText = attrs.wrapText;
  }

  const image: Image = {
    type: "image",
    rId: attrs.rId || "",
    src: attrs.src,
    size: {
      width: pixelsToEmu(attrs.width || 0),
      height: pixelsToEmu(attrs.height || 0),
    },
    wrap,
  };
  if (attrs.alt) {
    image.alt = attrs.alt;
  }
  if (attrs.title) {
    image.title = attrs.title;
  }

  const imageTransform = parseTransformAttr(attrs.transform);
  if (imageTransform) {
    image.transform = imageTransform;
  }

  // eigenpal #424 (opacity render pipeline). PM schema default is `null`;
  // use `!= null` so the model only carries an explicit opacity value.
  if (attrs.opacity != null) {
    image.opacity = attrs.opacity;
  }

  const imagePosition = imagePositionFromAttrs(attrs.position);
  if (imagePosition) {
    image.position = imagePosition;
  }

  // Round-trip border/outline
  if (attrs.borderWidth && attrs.borderWidth > 0) {
    const cssToOoxmlStyle: Record<string, string> = {
      solid: "solid",
      dotted: "dot",
      dashed: "dash",
      double: "solid",
      groove: "solid",
      ridge: "solid",
      inset: "solid",
      outset: "solid",
    };
    const outline: ShapeOutline = {
      width: pixelsToEmu(attrs.borderWidth),
      style: attrs.borderStyle
        ? (cssToOoxmlStyle[attrs.borderStyle] as ShapeOutline["style"]) ||
          "solid"
        : "solid",
    };
    if (attrs.borderColor) {
      outline.color = { rgb: attrs.borderColor.replace("#", "") };
    }
    image.outline = outline;
  }

  // Round-trip image hyperlink
  if (attrs.hlinkHref) {
    image.hlinkHref = attrs.hlinkHref;
  }

  // eigenpal #424: fold crop fractions back into Image.crop. PM defaults are
  // `null`, so `!= null` catches both null and undefined; zero sides are
  // omitted to keep the serialized <a:srcRect/> terse.
  const cropTop =
    attrs.cropTop != null && attrs.cropTop > 0 ? attrs.cropTop : undefined;
  const cropRight =
    attrs.cropRight != null && attrs.cropRight > 0
      ? attrs.cropRight
      : undefined;
  const cropBottom =
    attrs.cropBottom != null && attrs.cropBottom > 0
      ? attrs.cropBottom
      : undefined;
  const cropLeft =
    attrs.cropLeft != null && attrs.cropLeft > 0 ? attrs.cropLeft : undefined;
  if (
    cropTop !== undefined ||
    cropRight !== undefined ||
    cropBottom !== undefined ||
    cropLeft !== undefined
  ) {
    const crop: NonNullable<Image["crop"]> = {};
    if (cropTop !== undefined) {
      crop.top = cropTop;
    }
    if (cropRight !== undefined) {
      crop.right = cropRight;
    }
    if (cropBottom !== undefined) {
      crop.bottom = cropBottom;
    }
    if (cropLeft !== undefined) {
      crop.left = cropLeft;
    }
    image.crop = crop;
  }

  const drawingContent: DrawingContent = {
    type: "drawing",
    image,
  };
  if (attrs._docxRawXml) {
    drawingContent.rawXml = attrs._docxRawXml;
  }

  return {
    type: "run",
    content: [drawingContent],
  };
}

/**
 * Create a Run from a ProseMirror shape node
 */
function createShapeRun(node: PMNode): Run {
  const attrs = expectShapeAttrs(node);

  const shape: Shape = {
    type: "shape",
    shapeType: (attrs.shapeType || "rect") as Shape["shapeType"],
    size: {
      width: attrs.width ? pixelsToEmu(attrs.width) : 0,
      height: attrs.height ? pixelsToEmu(attrs.height) : 0,
    },
  };
  if (attrs.shapeId) {
    shape.id = attrs.shapeId;
  }
  const shapeTransform = parseTransformAttr(attrs.transform);
  if (shapeTransform) {
    shape.transform = shapeTransform;
  }

  const wrap: ImageWrap = { type: attrs.wrapType || "inline" };
  if (attrs.distTop !== undefined) {
    wrap.distT = pixelsToEmu(attrs.distTop);
  }
  if (attrs.distBottom !== undefined) {
    wrap.distB = pixelsToEmu(attrs.distBottom);
  }
  if (attrs.distLeft !== undefined) {
    wrap.distL = pixelsToEmu(attrs.distLeft);
  }
  if (attrs.distRight !== undefined) {
    wrap.distR = pixelsToEmu(attrs.distRight);
  }
  if (attrs.wrapText) {
    wrap.wrapText = attrs.wrapText;
  }
  shape.wrap = wrap;

  const shapePosition = imagePositionFromAttrs(attrs.position);
  if (shapePosition) {
    shape.position = shapePosition;
  }

  // Fill
  if (attrs.fillType === "gradient" && attrs.gradientStops) {
    // Round-trip gradient fill
    try {
      const parsed = JSON.parse(attrs.gradientStops) as {
        position: number;
        color: string;
      }[];
      const gradient: NonNullable<ShapeFill["gradient"]> = {
        type: (attrs.gradientType || "linear") as
          | "linear"
          | "radial"
          | "rectangular"
          | "path",
        stops: parsed.map((s) => ({
          position: s.position,
          color: { rgb: s.color.replace("#", "") },
        })),
      };
      if (attrs.gradientAngle) {
        gradient.angle = attrs.gradientAngle;
      }
      shape.fill = { type: "gradient", gradient };
    } catch {
      shape.fill = {
        type: "solid",
        color: { rgb: (attrs.fillColor || "000000").replace("#", "") },
      };
    }
  } else if (attrs.fillColor) {
    shape.fill = {
      type: attrs.fillType ?? "solid",
      color: { rgb: attrs.fillColor.replace("#", "") },
    };
  } else if (attrs.fillType === "none") {
    shape.fill = { type: "none" };
  }

  // Outline. `outlineStyle === "none"` is the explicit "no outline" sentinel
  // (see OUTLINE_STYLE_ATTR_VALUES): suppress the `<a:ln>` element entirely so a
  // border-free shape round-trips border-free, even if other outline attrs (a
  // leftover colour/width) linger on the node.
  if (
    attrs.outlineStyle !== "none" &&
    ((attrs.outlineWidth !== undefined && attrs.outlineWidth > 0) ||
      attrs.outlineColor ||
      attrs.outlineStyle ||
      attrs.outlineCap ||
      attrs.outlineHeadEnd ||
      attrs.outlineTailEnd)
  ) {
    const shapeOutline: ShapeOutline = {};
    if (attrs.outlineWidth !== undefined && attrs.outlineWidth > 0) {
      shapeOutline.width = pixelsToEmu(attrs.outlineWidth);
    }
    if (attrs.outlineStyle) {
      shapeOutline.style =
        normalizeShapeOutlineStyle(attrs.outlineStyle) ?? "solid";
    }
    if (attrs.outlineCap) {
      shapeOutline.cap = attrs.outlineCap;
    }
    if (attrs.outlineHeadEnd) {
      shapeOutline.headEnd = attrs.outlineHeadEnd;
    }
    if (attrs.outlineTailEnd) {
      shapeOutline.tailEnd = attrs.outlineTailEnd;
    }
    if (attrs.outlineColor) {
      shapeOutline.color = { rgb: attrs.outlineColor.replace("#", "") };
    }
    shape.outline = shapeOutline;
  }

  const shapeContent: ShapeContent = { type: "shape", shape };

  return {
    type: "run",
    content: [shapeContent],
  };
}

/**
 * Convert ProseMirror marks to TextFormatting
 */
export function marksToTextFormatting(marks: readonly Mark[]): TextFormatting {
  const formatting: TextFormatting = {};
  let characterStyleRPr: TextFormatting | undefined;

  for (const mark of marks) {
    switch (mark.type.name) {
      case "bold":
        formatting.bold = true;
        formatting.boldCs = true;
        break;

      case "italic":
        formatting.italic = true;
        formatting.italicCs = true;
        break;

      case "underline": {
        const attrs = expectUnderlineMarkAttrs(mark);
        const uline: NonNullable<TextFormatting["underline"]> = {
          style: attrs.style || "single",
        };
        if (attrs.color) {
          uline.color = attrs.color;
        }
        formatting.underline = uline;
        break;
      }

      case "strike":
        if (expectStrikeMarkAttrs(mark).double) {
          formatting.doubleStrike = true;
        } else {
          formatting.strike = true;
        }
        break;

      case "textColor": {
        const attrs = expectTextColorMarkAttrs(mark);
        const colorVal: ColorValue = {};
        if (attrs.rgb) {
          colorVal.rgb = attrs.rgb;
        }
        if (attrs.themeColor) {
          colorVal.themeColor = attrs.themeColor;
        }
        if (attrs.themeTint) {
          colorVal.themeTint = attrs.themeTint;
        }
        if (attrs.themeShade) {
          colorVal.themeShade = attrs.themeShade;
        }
        formatting.color = colorVal;
        break;
      }

      case "highlight":
        formatting.highlight = expectHighlightMarkAttrs(mark).color;
        break;

      case "runShading":
        // Rebuild the model `w:shd` fill so the run serializer re-emits it.
        formatting.shading = runShadingAttrsToShading(
          expectRunShadingMarkAttrs(mark),
        );
        break;

      case "fontSize": {
        const attrs = expectFontSizeMarkAttrs(mark);
        formatting.fontSize = attrs.size;
        formatting.fontSizeCs = attrs.size;
        break;
      }

      case "fontFamily": {
        const attrs = expectFontFamilyMarkAttrs(mark);
        const ff: NonNullable<TextFormatting["fontFamily"]> = {};
        if (attrs.ascii) {
          ff.ascii = attrs.ascii;
        }
        if (attrs.hAnsi) {
          ff.hAnsi = attrs.hAnsi;
        }
        if (attrs.eastAsia) {
          ff.eastAsia = attrs.eastAsia;
        }
        // Use stored cs value, falling back to ascii for Complex Script compatibility
        const csVal = attrs.cs || attrs.ascii;
        if (csVal) {
          ff.cs = csVal;
        }
        // asciiTheme needs to be cast to the proper type
        if (attrs.asciiTheme) {
          ff.asciiTheme = attrs.asciiTheme as NonNullable<
            NonNullable<TextFormatting["fontFamily"]>["asciiTheme"]
          >;
        }
        if (attrs.hAnsiTheme) {
          ff.hAnsiTheme = attrs.hAnsiTheme;
        }
        if (attrs.eastAsiaTheme) {
          ff.eastAsiaTheme = attrs.eastAsiaTheme;
        }
        if (attrs.csTheme) {
          ff.csTheme = attrs.csTheme;
        }
        formatting.fontFamily = ff;
        break;
      }

      case "superscript":
        formatting.vertAlign = "superscript";
        break;

      case "subscript":
        formatting.vertAlign = "subscript";
        break;

      case "allCaps":
        formatting.allCaps = true;
        break;

      case "smallCaps":
        formatting.smallCaps = true;
        break;

      case "characterSpacing": {
        const attrs = expectCharacterSpacingMarkAttrs(mark);
        if (attrs.spacing !== undefined) {
          formatting.spacing = attrs.spacing;
        }
        if (attrs.position !== undefined) {
          formatting.position = attrs.position;
        }
        if (attrs.scale !== undefined) {
          formatting.scale = attrs.scale;
        }
        if (attrs.kerning !== undefined) {
          formatting.kerning = attrs.kerning;
        }
        break;
      }

      case "emboss":
        formatting.emboss = true;
        break;

      case "imprint":
        formatting.imprint = true;
        break;

      case "hidden":
        // eigenpal #424 (w:vanish gap 9): mark closes the round-trip so
        // `<w:vanish/>` survives parse → PM → serialize.
        formatting.hidden = true;
        break;

      case "textShadow":
        formatting.shadow = true;
        break;

      case "emphasisMark":
        formatting.emphasisMark = expectEmphasisMarkAttrs(mark).type || "dot";
        break;

      case "textOutline":
        formatting.outline = true;
        break;

      case "rtl":
        formatting.rtl = true;
        break;

      case "textEffect":
        formatting.effect = expectTextEffectMarkAttrs(mark).effect;
        break;

      case "runFormattingOverride":
        applyRunFormattingOverrideAttrs(
          formatting,
          expectRunFormattingOverrideMarkAttrs(mark),
        );
        break;

      case "characterStyle": {
        const attrs = expectCharacterStyleMarkAttrs(mark);
        formatting.styleId = attrs.styleId;
        characterStyleRPr = attrs._styleRPr;
        break;
      }

      // hyperlink is handled separately
      default:
        break;
    }
  }

  if (characterStyleRPr) {
    return subtractCharacterStyleFormatting(formatting, characterStyleRPr);
  }

  return formatting;
}

/**
 * Drop run formatting values that the run's character style already provides
 * (the `w:rStyle` reference re-imposes them on load), so a styled run
 * serializes back to a style reference instead of baked direct formatting.
 *
 * `styleRPr` is the load-time snapshot from the characterStyle mark, captured
 * in the same normal form this module produces from marks, so value equality
 * is a faithful "came from the style and is unchanged" check. Values that
 * differ (user edits, direct overrides from the source document) stay as
 * direct formatting, which wins over the style per the OOXML cascade.
 */
function subtractCharacterStyleFormatting(
  formatting: TextFormatting,
  styleRPr: TextFormatting,
): TextFormatting {
  const result: TextFormatting = {};

  // SAFETY: Object.keys over a TextFormatting yields its own keys.
  for (const key of Object.keys(formatting) as (keyof TextFormatting)[]) {
    const value = formatting[key];
    if (value === undefined) {
      continue;
    }
    const styleValue = key === "styleId" ? undefined : styleRPr[key];
    // Both values come out of marksToTextFormatting, so equal values have
    // identical key insertion order and stringify identically.
    if (
      styleValue !== undefined &&
      JSON.stringify(value) === JSON.stringify(styleValue)
    ) {
      continue;
    }
    // SAFETY: dynamic property copy between identical TextFormatting keys.
    (result as Record<string, unknown>)[key] = value;
  }

  return result;
}

function applyRunFormattingOverrideAttrs(
  formatting: TextFormatting,
  attrs: RunFormattingOverrideAttrs,
): void {
  if (attrs.bold === false) {
    formatting.bold = false;
  }
  if (attrs.italic === false) {
    formatting.italic = false;
  }
  if (attrs.underline === "none") {
    formatting.underline = { style: "none" };
  }
  if (attrs.strike === false) {
    formatting.strike = false;
  }
  if (attrs.doubleStrike === false) {
    formatting.doubleStrike = false;
  }
  if (attrs.allCaps === false) {
    formatting.allCaps = false;
  }
  if (attrs.smallCaps === false) {
    formatting.smallCaps = false;
  }
  if (attrs.hidden === false) {
    formatting.hidden = false;
  }
  if (attrs.emboss === false) {
    formatting.emboss = false;
  }
  if (attrs.imprint === false) {
    formatting.imprint = false;
  }
  if (attrs.shadow === false) {
    formatting.shadow = false;
  }
  if (attrs.outline === false) {
    formatting.outline = false;
  }
  if (attrs.rtl === false) {
    formatting.rtl = false;
  }
}

// ============================================================================
// TABLE CONVERSION
// ============================================================================

/**
 * Convert a ProseMirror table node to our Table type
 */
function inferTableBorders(rows: TableRow[]): TableBorders | undefined {
  for (const row of rows) {
    for (const cell of row.cells) {
      const borders = cell.formatting?.borders;
      if (borders) {
        const base =
          borders.top ||
          borders.left ||
          borders.right ||
          borders.bottom ||
          borders.insideH ||
          borders.insideV;
        if (!base) {
          return undefined;
        }
        return {
          top: borders.top ?? base,
          bottom: borders.bottom ?? base,
          left: borders.left ?? base,
          right: borders.right ?? base,
          insideH: borders.insideH ?? borders.bottom ?? base,
          insideV: borders.insideV ?? borders.right ?? base,
        };
      }
    }
  }
  return undefined;
}

function convertPMTable(
  node: PMNode,
  documentCounts?: TrackedChangeCounts,
): Table {
  const attrs = expectTableAttrs(node);
  const rows = convertPMTableRows(node, documentCounts);

  const formatting = tableAttrsToFormatting(attrs) || undefined;
  if (!formatting?.borders) {
    const inferredBorders = inferTableBorders(rows);
    if (inferredBorders) {
      if (formatting) {
        formatting.borders = inferredBorders;
      } else {
        // No other formatting — create a minimal formatting object with borders
        // so borders persist on round-trip.
        const minTable: Table = {
          type: "table",
          formatting: { borders: inferredBorders },
          rows,
        };
        if (attrs.columnWidths) {
          minTable.columnWidths = attrs.columnWidths;
        }
        return minTable;
      }
    }
  }

  const table: Table = { type: "table", rows };
  if (attrs.columnWidths) {
    table.columnWidths = attrs.columnWidths;
  }
  if (formatting) {
    table.formatting = formatting;
  }
  return table;
}

type ActiveVerticalMerge = {
  remainingRows: number;
  colspan: number;
  continuationCells?: TableCell[];
};

function convertPMTableRows(
  node: PMNode,
  documentCounts?: TrackedChangeCounts,
): TableRow[] {
  const rows: TableRow[] = [];
  const activeVerticalMerges = new Map<number, ActiveVerticalMerge>();

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((rowNode) => {
    if (rowNode.type.name === "tableRow") {
      rows.push(
        convertPMTableRow(rowNode, documentCounts, activeVerticalMerges),
      );
    }
  });

  return rows;
}

/**
 * Build CellMargins from PM margin attrs (top/bottom/left/right as number|null|undefined)
 */
function buildCellMarginsFromAttrs(m: {
  top?: number | null;
  bottom?: number | null;
  left?: number | null;
  right?: number | null;
}): CellMargins {
  const margins: CellMargins = {};
  if (m.top !== null && m.top !== undefined) {
    margins.top = { value: m.top, type: "dxa" };
  }
  if (m.bottom !== null && m.bottom !== undefined) {
    margins.bottom = { value: m.bottom, type: "dxa" };
  }
  if (m.left !== null && m.left !== undefined) {
    margins.left = { value: m.left, type: "dxa" };
  }
  if (m.right !== null && m.right !== undefined) {
    margins.right = { value: m.right, type: "dxa" };
  }
  return margins;
}

/**
 * Convert ProseMirror table attrs to TableFormatting
 */
function tableAttrsToFormatting(
  attrs: TableAttrs,
): TableFormatting | undefined {
  // If we have the original formatting from the DOCX, use it as a base
  // for lossless round-trip. This preserves properties like cellSpacing,
  // indent, layout, bidi, overlap, shading that aren't tracked as PM attrs.
  if (attrs._originalFormatting) {
    const orig = attrs._originalFormatting;
    const result = { ...orig };

    // Override properties that user may have changed via editor commands
    if (attrs.styleId !== (orig.styleId ?? undefined)) {
      if (attrs.styleId) {
        result.styleId = attrs.styleId;
      } else {
        delete result.styleId;
      }
    }
    if (attrs.justification !== (orig.justification ?? undefined)) {
      if (attrs.justification) {
        result.justification = attrs.justification;
      } else {
        delete result.justification;
      }
    }
    if (attrs.floating !== (orig.floating ?? undefined)) {
      if (attrs.floating) {
        result.floating = attrs.floating;
      } else {
        delete result.floating;
      }
    }
    if (attrs.look !== (orig.look ?? undefined)) {
      if (attrs.look) {
        result.look = attrs.look;
      } else {
        delete result.look;
      }
    }
    // Borders: toProseDoc seeds attrs.borders with the same reference as
    // orig.borders, so a difference means a border command replaced them.
    if (attrs.borders !== (orig.borders ?? undefined)) {
      if (attrs.borders) {
        result.borders = attrs.borders;
      } else {
        delete result.borders;
      }
    }
    // Width: check if changed
    const tableWidth = attrs.width;
    const tableWidthType = attrs.widthType;
    const origWidthVal = orig.width?.value;
    const origWidthType = orig.width?.type;
    if (tableWidth !== origWidthVal || tableWidthType !== origWidthType) {
      if (tableWidth !== undefined || tableWidthType !== undefined) {
        result.width = {
          value: tableWidth ?? 0,
          type: tableWidthType ?? "dxa",
        };
      } else {
        delete result.width;
      }
    }
    // CellMargins: override if changed
    if (attrs.cellMargins) {
      result.cellMargins = buildCellMarginsFromAttrs(attrs.cellMargins);
    }

    return result;
  }

  // Fallback: reconstruct formatting from individual attrs (e.g. for
  // newly created tables that don't have _originalFormatting)
  const tableWidth = attrs.width;
  const tableWidthType = attrs.widthType;
  const hasFormatting =
    attrs.styleId ||
    tableWidth !== undefined ||
    tableWidthType !== undefined ||
    attrs.justification ||
    attrs.floating ||
    attrs.cellMargins ||
    attrs.look ||
    attrs.borders;

  if (!hasFormatting) {
    return undefined;
  }

  // Convert cellMargins back to CellMargins format (twips → TableMeasurement)
  const cellMargins = attrs.cellMargins
    ? buildCellMarginsFromAttrs(attrs.cellMargins)
    : undefined;

  // Restore width — handle width=0 with type="auto" (common OOXML pattern)
  let width: TableFormatting["width"];
  if (tableWidth !== undefined || tableWidthType !== undefined) {
    width = {
      value: tableWidth ?? 0,
      type: tableWidthType ?? "dxa",
    };
  }

  const f: TableFormatting = {};
  if (attrs.styleId) {
    f.styleId = attrs.styleId;
  }
  if (width) {
    f.width = width;
  }
  if (attrs.justification) {
    f.justification = attrs.justification;
  }
  if (attrs.floating) {
    f.floating = attrs.floating;
  }
  if (cellMargins) {
    f.cellMargins = cellMargins;
  }
  if (attrs.look) {
    f.look = attrs.look;
  }
  if (attrs.borders) {
    f.borders = attrs.borders;
  }
  return f;
}

/**
 * Convert a ProseMirror table row node to our TableRow type
 */
function convertPMTableRow(
  node: PMNode,
  documentCounts?: TrackedChangeCounts,
  activeVerticalMerges?: Map<number, ActiveVerticalMerge>,
): TableRow {
  const attrs = expectTableRowAttrs(node);
  const cells: TableCell[] = [];
  let gridColumn = 0;

  const appendActiveVerticalMerges = (): void => {
    if (!activeVerticalMerges) {
      return;
    }

    let activeMerge = activeVerticalMerges.get(gridColumn);
    while (activeMerge) {
      const preservedCell = activeMerge.continuationCells?.shift();
      cells.push(
        preservedCell ??
          createVerticalMergeContinuationCell(activeMerge.colspan),
      );
      activeMerge.remainingRows -= 1;
      if (activeMerge.remainingRows <= 0) {
        activeVerticalMerges.delete(gridColumn);
      }
      gridColumn += activeMerge.colspan;
      activeMerge = activeVerticalMerges.get(gridColumn);
    }
  };

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((cellNode) => {
    appendActiveVerticalMerges();
    if (
      cellNode.type.name === "tableCell" ||
      cellNode.type.name === "tableHeader"
    ) {
      const cellAttrs = expectTableCellAttrs(cellNode);
      const colspan = Math.max(cellAttrs.colspan, 1);
      cells.push(convertPMTableCell(cellNode, documentCounts));
      if (cellAttrs.rowspan > 1) {
        const continuationCells = cellAttrs._docxVMergeContinuationCells;
        activeVerticalMerges?.set(gridColumn, {
          remainingRows: cellAttrs.rowspan - 1,
          colspan,
          ...(continuationCells
            ? { continuationCells: [...continuationCells] }
            : {}),
        });
      }
      gridColumn += colspan;
    }
  });
  appendActiveVerticalMerges();

  const row: TableRow = { type: "tableRow", cells };
  const rowFormatting = tableRowAttrsToFormatting(attrs);
  if (rowFormatting) {
    row.formatting = rowFormatting;
  }
  return row;
}

function createVerticalMergeContinuationCell(colspan: number): TableCell {
  const formatting: TableCellFormatting = { vMerge: "continue" };
  if (colspan > 1) {
    formatting.gridSpan = colspan;
  }
  return {
    type: "tableCell",
    content: [{ type: "paragraph", content: [] }],
    formatting,
  };
}

/**
 * Convert ProseMirror table row attrs to TableRowFormatting
 */
function tableRowAttrsToFormatting(
  attrs: TableRowAttrs,
): TableRowFormatting | undefined {
  // If we have the original formatting from the DOCX, use it as a base
  // for lossless round-trip. This preserves properties like cantSplit,
  // justification, hidden, conditionalFormat that aren't tracked as PM attrs.
  if (attrs._originalFormatting) {
    const orig = attrs._originalFormatting;
    const result = { ...orig };

    // Override properties that user may have changed via editor commands
    if (attrs.height !== (orig.height?.value ?? undefined)) {
      if (attrs.height) {
        result.height = { value: attrs.height, type: "dxa" as const };
      } else {
        delete result.height;
      }
    }
    if (attrs.heightRule !== (orig.heightRule ?? undefined)) {
      if (attrs.heightRule) {
        result.heightRule = attrs.heightRule;
      } else {
        delete result.heightRule;
      }
    }
    if (attrs.isHeader !== (orig.header ?? undefined)) {
      if (attrs.isHeader) {
        result.header = attrs.isHeader;
      } else {
        delete result.header;
      }
    }

    return result;
  }

  // Fallback: reconstruct formatting from individual attrs
  const hasFormatting = attrs.height || attrs.isHeader;

  if (!hasFormatting) {
    return undefined;
  }

  const f: TableRowFormatting = {};
  if (attrs.height) {
    f.height = { value: attrs.height, type: "dxa" };
  }
  if (attrs.heightRule) {
    f.heightRule = attrs.heightRule;
  }
  if (attrs.isHeader) {
    f.header = attrs.isHeader;
  }
  return f;
}

/**
 * Convert a ProseMirror table cell node to our TableCell type
 */
function convertPMTableCell(
  node: PMNode,
  documentCounts?: TrackedChangeCounts,
): TableCell {
  const attrs = expectTableCellAttrs(node);
  const content: (Paragraph | Table)[] = [];

  // Extract cell content (paragraphs and nested tables)
  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((contentNode) => {
    if (contentNode.type.name === "paragraph") {
      content.push(convertPMParagraph(contentNode, documentCounts));
    } else if (contentNode.type.name === "table") {
      content.push(convertPMTable(contentNode, documentCounts));
    }
  });

  const cell: TableCell = { type: "tableCell", content };
  const cellFormatting = tableCellAttrsToFormatting(attrs);
  if (cellFormatting) {
    cell.formatting = cellFormatting;
  }
  return cell;
}

/**
 * Convert ProseMirror table cell attrs to TableCellFormatting
 * Borders are stored as full BorderSpec objects — no conversion needed.
 */
function tableCellAttrsToFormatting(
  attrs: TableCellAttrs,
): TableCellFormatting | undefined {
  // If we have the original formatting from the DOCX, use it as a base
  // for lossless round-trip. This preserves properties like vMerge, fitText,
  // hideMark, conditionalFormat that aren't tracked as PM attrs.
  if (attrs._originalFormatting) {
    const orig = attrs._originalFormatting;
    const result = { ...orig };

    // Override properties that user may have changed via editor commands
    if (attrs.colspan > 1) {
      result.gridSpan = attrs.colspan;
    }
    if (attrs.rowspan > 1) {
      result.vMerge = "restart";
    } else if (result.vMerge === "restart" && !attrs._preserveVMergeRestart) {
      delete result.vMerge;
    }
    const cellWidth = attrs.width;
    // Width: keep null absent while preserving explicit width=0 values.
    if (cellWidth !== undefined) {
      result.width = {
        value: cellWidth,
        type: attrs.widthType ?? "dxa",
      };
    }
    if (attrs.verticalAlign !== (orig.verticalAlign ?? undefined)) {
      if (attrs.verticalAlign) {
        result.verticalAlign = attrs.verticalAlign;
      } else {
        delete result.verticalAlign;
      }
    }
    if (attrs.backgroundColor) {
      result.shading = { fill: { rgb: attrs.backgroundColor } };
    } else if (!attrs.backgroundColor && orig.shading) {
      // User cleared the background color
      delete result.shading;
    }
    if (attrs.borders) {
      result.borders = attrs.borders;
    }
    if (attrs.margins) {
      result.margins = buildCellMarginsFromAttrs(attrs.margins);
    }
    if (attrs.textDirection !== (orig.textDirection ?? undefined)) {
      if (attrs.textDirection) {
        result.textDirection = attrs.textDirection;
      } else {
        delete result.textDirection;
      }
    }

    return result;
  }

  // Fallback: reconstruct formatting from individual attrs
  const cellWidth = attrs.width;
  const hasFormatting =
    attrs.colspan > 1 ||
    attrs.rowspan > 1 ||
    cellWidth !== undefined ||
    attrs.verticalAlign ||
    attrs.backgroundColor ||
    attrs.borders ||
    attrs.margins ||
    attrs.textDirection;

  if (!hasFormatting) {
    return undefined;
  }

  const f: TableCellFormatting = {};
  if (attrs.colspan > 1) {
    f.gridSpan = attrs.colspan;
  }
  if (attrs.rowspan > 1) {
    f.vMerge = "restart";
  }
  if (cellWidth !== undefined) {
    f.width = {
      value: cellWidth,
      type: attrs.widthType ?? "dxa",
    };
  }
  if (attrs.verticalAlign) {
    f.verticalAlign = attrs.verticalAlign;
  }
  if (attrs.textDirection) {
    f.textDirection = attrs.textDirection;
  }
  if (attrs.backgroundColor) {
    f.shading = { fill: { rgb: attrs.backgroundColor } };
  }
  if (attrs.borders) {
    f.borders = attrs.borders;
  }
  if (attrs.margins) {
    f.margins = buildCellMarginsFromAttrs(attrs.margins);
  }
  return f;
}

// ============================================================================
// TEXT BOX CONVERSION
// ============================================================================

/**
 * Convert a ProseMirror textBox node back to a Paragraph wrapping a ShapeContent run.
 * The text box content becomes a Shape with textBody.
 */
function convertPMTextBox(node: PMNode): Paragraph {
  const attrs = expectTextBoxAttrs(node);

  // Extract child paragraphs from the text box content
  const childParagraphs: Paragraph[] = [];
  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child) => {
    if (child.type.name === "paragraph") {
      childParagraphs.push(convertPMParagraph(child));
    }
    // Tables inside text boxes are currently not round-tripped
  });

  // Build shape with text body
  const shape: Shape = {
    type: "shape",
    shapeType: "textBox",
    size: {
      width: attrs.width ? pixelsToEmu(attrs.width) : 0,
      height: attrs.height ? pixelsToEmu(attrs.height) : 0,
    },
    textBody: {
      content:
        childParagraphs.length > 0
          ? childParagraphs
          : [{ type: "paragraph", content: [] }],
      margins: (() => {
        const m: {
          top?: number;
          bottom?: number;
          left?: number;
          right?: number;
        } = {};
        if (typeof attrs.marginTop === "number") {
          m.top = pixelsToEmu(attrs.marginTop);
        }
        if (typeof attrs.marginBottom === "number") {
          m.bottom = pixelsToEmu(attrs.marginBottom);
        }
        if (typeof attrs.marginLeft === "number") {
          m.left = pixelsToEmu(attrs.marginLeft);
        }
        if (typeof attrs.marginRight === "number") {
          m.right = pixelsToEmu(attrs.marginRight);
        }
        return m;
      })(),
    },
  };

  if (attrs.textBoxId) {
    shape.id = attrs.textBoxId;
  }

  // Convert fill color back
  if (attrs.fillColor) {
    shape.fill = {
      type: "solid",
      color: { rgb: attrs.fillColor.replace("#", "") },
    };
  }

  // Convert outline back. `outlineStyle === "none"` is the explicit no-outline
  // sentinel: drop the `<a:ln>` even if a width lingers, matching the shape path.
  if (
    attrs.outlineStyle !== "none" &&
    attrs.outlineWidth &&
    attrs.outlineWidth > 0
  ) {
    const tbOutline: ShapeOutline = {
      width: pixelsToEmu(attrs.outlineWidth),
      style: normalizeShapeOutlineStyle(attrs.outlineStyle) ?? "solid",
    };
    if (attrs.outlineColor) {
      tbOutline.color = { rgb: attrs.outlineColor.replace("#", "") };
    }
    shape.outline = tbOutline;
  }

  const wrap = textBoxWrapFromAttrs(attrs);
  if (wrap) {
    shape.wrap = wrap;
  }
  const position = imagePositionFromAttrs(attrs.position);
  if (position) {
    shape.position = position;
  }

  // Wrap the shape in a paragraph with a run containing ShapeContent
  const shapeContent: ShapeContent = { type: "shape", shape };
  const run: Run = { type: "run", content: [shapeContent] };

  return {
    type: "paragraph",
    content: [run],
  };
}

/**
 * Update a Document with content from a ProseMirror document
 * Preserves all non-content parts of the original document
 */
export function updateDocumentContent(
  originalDocument: Document,
  pmDoc: PMNode,
): Document {
  return fromProseDoc(pmDoc, originalDocument);
}

/**
 * Convert a ProseMirror document back to an array of `BlockContent` blocks
 * (paragraphs, tables, and block-level content controls).
 *
 * Used for converting edited header/footer PM content back to the document
 * model.
 */
export function proseDocToBlocks(pmDoc: PMNode): BlockContent[] {
  return extractBlocks(pmDoc);
}
