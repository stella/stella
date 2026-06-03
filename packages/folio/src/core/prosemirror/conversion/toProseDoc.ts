/**
 * Document to ProseMirror Conversion
 *
 * Converts our Document type (from DOCX parsing) to a ProseMirror document.
 * Preserves all formatting attributes for round-trip fidelity.
 *
 * Style Resolution:
 * When styles are provided, paragraph properties are resolved from the style chain:
 * - Document defaults (docDefaults)
 * - Normal style (if no explicit styleId)
 * - Style chain (basedOn inheritance)
 * - Inline properties (highest priority)
 */

import type { MarkType, Node as PMNode } from "prosemirror-model";

import { createStyleEngine } from "../../style-engine";
import type { StyleEngine } from "../../style-engine";
import type {
  BlockContent,
  BlockSdt,
  Document,
  Paragraph,
  Run,
  TextFormatting,
  RunContent,
  Hyperlink,
  Image,
  TextBox,
  Shape,
  StyleDefinitions,
  Table,
  TableRow,
  TableCell,
  TableCellFormatting,
  TableBorders,
  TableLook,
  SimpleField,
  ComplexField,
  InlineSdt,
  Insertion,
  Deletion,
  MoveFrom,
  MoveTo,
  MathEquation,
  Theme,
} from "../../types/document";
import { resolveColor } from "../../utils/colorResolver";
import { mergeTextFormatting } from "../../utils/textFormattingMerge";
import { emuToPixels } from "../../utils/units";
import { buildRunFormattingOverrideAttrs } from "../extensions/marks/RunFormattingOverrideExtension";
import { schema } from "../schema";
import type {
  ImagePositionAttrs,
  ParagraphAttrs,
  TableAttrs,
  TableRowAttrs,
  TableCellAttrs,
} from "../schema/nodes";
import { assertValidProseMirrorDocument } from "../validation";

/**
 * Options for document conversion
 */
export type ToProseDocOptions = {
  /** Style definitions for resolving paragraph styles */
  styles?: StyleDefinitions;
  /** Theme used when converting themed table/cell values in nested content. */
  theme?: Theme | null;
};

type RunFormattingResolver = (
  formatting: TextFormatting | undefined,
) => TextFormatting | undefined;

/**
 * Convert a Document to a ProseMirror document
 *
 * @param document - The Document to convert
 * @param options - Conversion options including style definitions
 */
export function toProseDoc(
  document: Document,
  options?: ToProseDocOptions,
): PMNode {
  const paragraphs = document.package.document.content;
  const nodes: PMNode[] = [];

  const styleResolver = createStyleEngine(options?.styles);
  const theme = options?.theme ?? document.package.theme ?? null;
  let textBoxGroupIndex = 0;

  const convertBodyBlocks = (blocks: BlockContent[]): PMNode[] => {
    const out: PMNode[] = [];
    for (const block of blocks) {
      if (block.type === "paragraph") {
        const pbPos = paragraphPageBreakPosition(block);
        if (pbPos === "before") {
          out.push(schema.node("pageBreak"));
        }
        out.push(
          ...convertParagraphWithTextBoxes(
            block,
            styleResolver,
            String(textBoxGroupIndex),
          ),
        );
        textBoxGroupIndex += 1;
        if (pbPos === "after") {
          out.push(schema.node("pageBreak"));
        }
      } else if (block.type === "table") {
        out.push(convertTable(block, styleResolver, theme));
      } else {
        out.push(convertBlockSdt(block, convertBodyBlocks));
      }
    }
    return out;
  };

  nodes.push(...convertBodyBlocks(paragraphs));

  // Caret-after-final-SDT affordance is provided by `prosemirror-gapcursor`
  // at runtime; we previously injected a trailing empty paragraph here so
  // the caret was not trapped inside an isolating blockSdt, but the
  // synthetic paragraph survived `fromProseDoc` on save and silently
  // appended a `<w:p/>` to the DOCX on every round trip (which adds blank
  // space and shifts pagination in legal templates).

  // Ensure we have at least one paragraph
  if (nodes.length === 0) {
    nodes.push(schema.node("paragraph", {}, []));
  }

  const pmDoc = schema.node("doc", null, nodes);
  assertValidProseMirrorDocument(
    pmDoc,
    "Document conversion produced an invalid ProseMirror document",
  );
  return pmDoc;
}

/**
 * Convert a `BlockSdt` model node into a `blockSdt` PM node, recursively
 * converting its children with the caller-supplied block converter. Pass
 * `rawPropertiesXml` / `rawEndPropertiesXml` through as attrs so the
 * serializer can replay them verbatim after a save.
 */
function convertBlockSdt(
  blockSdt: BlockSdt,
  convertBlocks: (blocks: BlockContent[]) => PMNode[],
): PMNode {
  const props = blockSdt.properties;
  const attrs: Record<string, unknown> = {
    sdtType: props.sdtType,
    alias: props.alias ?? null,
    tag: props.tag ?? null,
    id: props.id ?? null,
    lock: props.lock ?? null,
    placeholder: props.placeholder ?? null,
    showingPlaceholder: props.showingPlaceholder ?? false,
    dateFormat: props.dateFormat ?? null,
    dateValueISO: props.dateValueISO ?? null,
    listItems: props.listItems ? JSON.stringify(props.listItems) : null,
    dropdownLastValue: props.dropdownLastValue ?? null,
    checked: props.checked ?? null,
    // Mark explicitly when the source content was empty. fromProseDoc reads
    // this on save to drop the synthetic filler below — without an explicit
    // marker we couldn't distinguish source `<w:sdtContent/>` (filler
    // inserted here) from source `<w:sdtContent><w:p/></w:sdtContent>`
    // (a real authored empty paragraph the user wants preserved).
    _originallyEmpty: blockSdt.content.length === 0,
    rawPropertiesXml: props.rawPropertiesXml ?? null,
    rawEndPropertiesXml: props.rawEndPropertiesXml ?? null,
    rawSdtChildrenBeforeContent: props.rawSdtChildrenBeforeContent ?? null,
    rawSdtChildrenAfterContent: props.rawSdtChildrenAfterContent ?? null,
  };
  const children = convertBlocks(blockSdt.content);
  // ProseMirror `blockSdt` requires at least one block child; insert an empty
  // paragraph for a truly empty control rather than producing an invalid node.
  if (children.length === 0) {
    children.push(schema.node("paragraph", {}, []));
  }
  return schema.node("blockSdt", attrs, children);
}

/**
 * Convert a Paragraph to a ProseMirror paragraph node
 *
 * Resolves style-based text formatting and passes it to runs so that
 * paragraph styles (like Heading1) apply their font size, color, etc.
 */
function convertParagraph(
  paragraph: Paragraph,
  styleResolver: StyleEngine | null,
  activeCommentIds?: Set<number>,
  extraRunFormatting?: TextFormatting,
): PMNode {
  const attrs = paragraphFormattingToAttrs(paragraph, styleResolver);
  const inlineNodes: PMNode[] = [];
  let inlineOffset = 0;
  let bookmarksArr: { id: number; name: string }[] | undefined;
  let emptyHyperlinks:
    | NonNullable<ParagraphAttrs["_emptyHyperlinks"]>
    | undefined;
  let hyperlinkIndex = 0;

  // Track active comment ranges for this paragraph
  const commentIds = activeCommentIds ?? new Set<number>();
  const emitInlineNodes = (nodes: PMNode[]): void => {
    if (nodes.length === 0) {
      return;
    }
    const markedNodes = applyCommentMarks(nodes, commentIds);
    inlineNodes.push(...markedNodes);
    for (const node of markedNodes) {
      inlineOffset += node.nodeSize;
    }
  };
  const emitInlineNode = (node: PMNode | null): void => {
    if (!node) {
      return;
    }
    emitInlineNodes([node]);
  };

  // Get style-based text formatting (font size, bold, color, etc.)
  let styleRunFormatting: TextFormatting | undefined;
  if (styleResolver) {
    const resolved = styleResolver.resolveParagraphStyle(
      paragraph.formatting?.styleId,
    );
    styleRunFormatting = resolved.runFormatting;
  }

  const paragraphRunFormatting = paragraph.formatting?.runProperties
    ? resolveTextFormatting(paragraph.formatting.runProperties, styleResolver)
    : undefined;
  // Word does not propagate paragraph-mark-only visual decorations
  // (highlight, shading) to body runs — they paint the pilcrow alone. Strip
  // them off the inheritance path so a `<w:pPr><w:rPr><w:highlight/></w:rPr>`
  // used to mark just the paragraph glyph doesn't bleed onto every run.
  const inheritableParagraphRunFormatting = paragraphRunFormatting
    ? stripParagraphMarkOnlyFormatting(paragraphRunFormatting)
    : undefined;
  const baseRunFormatting = mergeTextFormatting(
    styleRunFormatting,
    extraRunFormatting,
  );
  const defaultRunFormatting = mergeTextFormatting(
    baseRunFormatting,
    inheritableParagraphRunFormatting,
  );
  const getInheritedRunFormatting = (
    formatting: TextFormatting | undefined,
  ): TextFormatting | undefined => {
    if (!hasDirectRunFormatting(formatting)) {
      return defaultRunFormatting;
    }
    return suppressParagraphMarkFormatting(
      baseRunFormatting,
      inheritableParagraphRunFormatting,
      formatting,
    );
  };
  const emitTrackedChange = (
    change: Insertion | Deletion | MoveFrom | MoveTo,
    markType: "insertion" | "deletion",
    moveKind: "moveFrom" | "moveTo" | null,
  ): void => {
    emitInlineNodes(
      convertTrackedChange(
        change,
        markType,
        getInheritedRunFormatting,
        styleResolver,
        moveKind,
      ),
    );
  };

  for (const content of paragraph.content) {
    if (content.type === "commentRangeStart") {
      commentIds.add(content.id);
    } else if (content.type === "commentRangeEnd") {
      commentIds.delete(content.id);
    } else if (content.type === "commentReference") {
      anchorPointComment(inlineNodes, content.id);
    } else if (content.type === "run") {
      emitInlineNodes(
        convertRun(
          content,
          getInheritedRunFormatting(content.formatting),
          styleResolver,
        ),
      );
    } else if (content.type === "hyperlink") {
      const currentHyperlinkIndex = hyperlinkIndex;
      hyperlinkIndex += 1;
      const linkNodes = convertHyperlink(
        content,
        getInheritedRunFormatting,
        styleResolver,
        currentHyperlinkIndex,
      );
      if (linkNodes.length === 0) {
        emptyHyperlinks ??= [];
        emptyHyperlinks.push({
          offset: inlineOffset,
          ...(content.href !== undefined ? { href: content.href } : {}),
          ...(content.anchor !== undefined ? { anchor: content.anchor } : {}),
          ...(content.tooltip !== undefined
            ? { tooltip: content.tooltip }
            : {}),
          ...(content.rId !== undefined ? { rId: content.rId } : {}),
        });
        continue;
      }
      emitInlineNodes(linkNodes);
    } else if (
      content.type === "simpleField" ||
      content.type === "complexField"
    ) {
      emitInlineNode(convertField(content, getInheritedRunFormatting));
    } else if (content.type === "inlineSdt") {
      emitInlineNode(
        convertInlineSdt(content, getInheritedRunFormatting, styleResolver),
      );
    } else if (content.type === "insertion" || content.type === "moveTo") {
      emitTrackedChange(
        content,
        "insertion",
        content.type === "moveTo" ? "moveTo" : null,
      );
    } else if (content.type === "deletion" || content.type === "moveFrom") {
      emitTrackedChange(
        content,
        "deletion",
        content.type === "moveFrom" ? "moveFrom" : null,
      );
    } else if (content.type === "mathEquation") {
      emitInlineNode(convertMathEquation(content));
    }
    // Collect bookmarkStart entries for round-trip
    if (content.type === "bookmarkStart") {
      if (!bookmarksArr) {
        bookmarksArr = [];
      }
      bookmarksArr.push({ id: content.id, name: content.name });
    }
  }

  if (bookmarksArr) {
    attrs.bookmarks = bookmarksArr;
  }
  if (emptyHyperlinks) {
    attrs._emptyHyperlinks = emptyHyperlinks;
  }

  return schema.node("paragraph", attrs, inlineNodes);
}

/**
 * Apply comment marks to PM nodes within a comment range.
 * Only the first active comment ID is used (comments don't overlap visually).
 */
function applyCommentMarks(nodes: PMNode[], commentIds: Set<number>): PMNode[] {
  if (commentIds.size === 0) {
    return nodes;
  }
  const commentId = [...commentIds][0]; // Use first active comment
  const commentMark = schema.marks["comment"]!.create({ commentId });

  return nodes.map((node) => {
    if (
      node.isText ||
      (node.isInline && node.type.allowsMarkType(commentMark.type))
    ) {
      return node.mark(commentMark.addToSet(node.marks));
    }
    return node;
  });
}

function anchorPointComment(nodes: PMNode[], commentId: number): void {
  const commentMark = schema.marks["comment"]?.create({ commentId });
  if (!commentMark) {
    return;
  }

  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (!node?.isText) {
      continue;
    }
    nodes[index] = node.mark(commentMark.addToSet(node.marks));
    return;
  }
}

/**
 * Convert tracked change (insertion or deletion) content to PM nodes with
 * an insertion/deletion mark applied.
 */
function convertTrackedChange(
  change: Insertion | Deletion | MoveFrom | MoveTo,
  markType: "insertion" | "deletion",
  getInheritedRunFormatting: RunFormattingResolver,
  styleResolver?: StyleEngine | null,
  moveKind: "moveFrom" | "moveTo" | null = null,
): PMNode[] {
  const nodes: PMNode[] = [];
  let hyperlinkIndex = 0;
  for (const item of change.content) {
    if (item.type === "run") {
      nodes.push(
        ...convertRun(
          item,
          getInheritedRunFormatting(item.formatting),
          styleResolver,
        ),
      );
    } else {
      const currentHyperlinkIndex = hyperlinkIndex;
      hyperlinkIndex += 1;
      nodes.push(
        ...convertHyperlink(
          item,
          getInheritedRunFormatting,
          styleResolver,
          currentHyperlinkIndex,
        ),
      );
    }
  }

  // SAFETY: markType is "insertion" | "deletion", both registered in schema
  const mark = schema.marks[markType]!.create({
    revisionId: change.info.id,
    author: change.info.author,
    date: change.info.date ?? null,
    moveKind,
  });

  return nodes.map((node) => {
    if (canCarryTrackedRunMark(node, mark.type)) {
      return node.mark(mark.addToSet(node.marks));
    }
    return node;
  });
}

function canCarryTrackedRunMark(node: PMNode, markType: MarkType): boolean {
  return (
    node.isText ||
    (node.isInline &&
      node.type.allowsMarkType(markType) &&
      (node.type.name === "image" ||
        node.type.name === "shape" ||
        node.type.name === "hardBreak" ||
        node.type.name === "tab"))
  );
}

/**
 * Convert ParagraphFormatting to ProseMirror paragraph attrs
 *
 * If a styleResolver is provided, resolves style-based formatting and merges
 * with inline formatting. Inline formatting takes precedence.
 */
function paragraphFormattingToAttrs(
  paragraph: Paragraph,
  styleResolver: StyleEngine | null,
): ParagraphAttrs {
  const formatting = paragraph.formatting;
  const styleId = formatting?.styleId;

  // Start with base attrs — only include defined values
  const attrs: ParagraphAttrs = {};

  if (paragraph.paraId) {
    attrs.paraId = paragraph.paraId;
  }
  if (paragraph.textId) {
    attrs.textId = paragraph.textId;
  }
  if (styleId) {
    attrs.styleId = styleId;
  }
  if (formatting?.numPr) {
    attrs.numPr = formatting.numPr;
  }
  // List rendering info from parsed numbering definitions
  if (paragraph.listRendering?.numFmt) {
    attrs.listNumFmt = paragraph.listRendering.numFmt;
  }
  if (paragraph.listRendering?.isBullet) {
    attrs.listIsBullet = paragraph.listRendering.isBullet;
  }
  if (paragraph.listRendering?.isLegal) {
    attrs.listIsLegal = paragraph.listRendering.isLegal;
  }
  if (paragraph.listRendering?.marker) {
    attrs.listMarker = paragraph.listRendering.marker;
  }
  if (paragraph.listRendering?.markerHidden) {
    attrs.listMarkerHidden = paragraph.listRendering.markerHidden;
  }
  if (paragraph.listRendering?.markerFontFamily) {
    attrs.listMarkerFontFamily = paragraph.listRendering.markerFontFamily;
  }
  if (paragraph.listRendering?.markerFontSize) {
    attrs.listMarkerFontSize = paragraph.listRendering.markerFontSize;
  }
  if (paragraph.listRendering?.markerSuffix) {
    attrs.listMarkerSuffix = paragraph.listRendering.markerSuffix;
  }
  if (paragraph.listRendering?.markerAllCaps) {
    attrs.listMarkerAllCaps = paragraph.listRendering.markerAllCaps;
  }
  if (paragraph.listRendering?.implicitChildLevelAdvances !== undefined) {
    attrs.listImplicitChildLevelAdvances =
      paragraph.listRendering.implicitChildLevelAdvances;
  }
  if (paragraph.listRendering?.markerSecondSlotOffsetTwips !== undefined) {
    attrs.listMarkerSecondSlotOffsetTwips =
      paragraph.listRendering.markerSecondSlotOffsetTwips;
  }
  if (paragraph.listRendering?.levelNumFmts) {
    attrs.listLevelNumFmts = paragraph.listRendering.levelNumFmts;
  }
  if (paragraph.listRendering?.abstractNumId !== undefined) {
    attrs.listAbstractNumId = paragraph.listRendering.abstractNumId;
  }
  if (paragraph.listRendering?.startOverride !== undefined) {
    attrs.listStartOverride = paragraph.listRendering.startOverride;
  }
  // Store original inline formatting for lossless serialization round-trip
  if (formatting) {
    attrs._originalFormatting = formatting;
  }
  // Carry `w:pPrChange` (paragraph-property-change tracking) opaquely
  // through ProseMirror. Without this, every edit strips the entries
  // off the paragraph because nothing in PM's schema represents them.
  // Shallow-clone the array so the editor state owns its own
  // reference — mutating the Folio document later must not poke
  // through into PM attrs.
  if (paragraph.propertyChanges && paragraph.propertyChanges.length > 0) {
    attrs._propertyChanges = [...paragraph.propertyChanges];
  }
  if (paragraph.pPrMark) {
    attrs.pPrMark = paragraph.pPrMark;
  }

  // Helper: assign a value only when defined
  const set = <K extends keyof ParagraphAttrs>(
    key: K,
    val: ParagraphAttrs[K] | undefined,
  ): void => {
    if (val !== undefined) {
      attrs[key] = val;
    }
  };

  // If we have a style resolver, resolve the style and get base properties
  if (styleResolver) {
    const resolved = styleResolver.resolveParagraphStyle(styleId);
    const stylePpr = resolved.paragraphFormatting;

    // Apply style-based values as defaults (inline overrides)
    set("alignment", formatting?.alignment ?? stylePpr?.alignment);
    set("spaceBefore", formatting?.spaceBefore ?? stylePpr?.spaceBefore);
    set("spaceAfter", formatting?.spaceAfter ?? stylePpr?.spaceAfter);
    set("lineSpacing", formatting?.lineSpacing ?? stylePpr?.lineSpacing);
    set(
      "lineSpacingRule",
      formatting?.lineSpacingRule ?? stylePpr?.lineSpacingRule,
    );
    set("spacingExplicit", formatting?.spacingExplicit);
    set("indentLeft", formatting?.indentLeft ?? stylePpr?.indentLeft);
    set("indentRight", formatting?.indentRight ?? stylePpr?.indentRight);
    set(
      "indentFirstLine",
      formatting?.indentFirstLine ?? stylePpr?.indentFirstLine,
    );
    set("hangingIndent", formatting?.hangingIndent ?? stylePpr?.hangingIndent);
    set("borders", formatting?.borders ?? stylePpr?.borders);
    set("shading", formatting?.shading ?? stylePpr?.shading);
    set("tabs", formatting?.tabs ?? stylePpr?.tabs);

    // Page break control
    set(
      "pageBreakBefore",
      formatting?.pageBreakBefore ?? stylePpr?.pageBreakBefore,
    );
    set("keepNext", formatting?.keepNext ?? stylePpr?.keepNext);
    set("keepLines", formatting?.keepLines ?? stylePpr?.keepLines);
    set(
      "contextualSpacing",
      formatting?.contextualSpacing ?? stylePpr?.contextualSpacing,
    );
    // Run-in heading (`<w:specVanish/>` on the paragraph mark) — see
    // ParagraphAttrs.runInWithNext.
    set("runInWithNext", formatting?.runInWithNext ?? stylePpr?.runInWithNext);

    // Outline level (for TOC)
    set("outlineLevel", formatting?.outlineLevel ?? stylePpr?.outlineLevel);

    // Text direction
    set("bidi", formatting?.bidi ?? stylePpr?.bidi);

    set(
      "defaultTextFormatting",
      resolveParagraphDefaultTextFormatting(styleId, formatting, styleResolver),
    );

    // If style defines numPr but inline doesn't, use style's numPr
    // numId === 0 means "no numbering" per OOXML spec — skip it
    if (!formatting?.numPr && stylePpr?.numPr && stylePpr.numPr.numId !== 0) {
      attrs.numPr = stylePpr.numPr;
    }
  } else {
    // No style resolver - use inline formatting only
    set("alignment", formatting?.alignment);
    set("spaceBefore", formatting?.spaceBefore);
    set("spaceAfter", formatting?.spaceAfter);
    set("lineSpacing", formatting?.lineSpacing);
    set("lineSpacingRule", formatting?.lineSpacingRule);
    set("spacingExplicit", formatting?.spacingExplicit);
    set("indentLeft", formatting?.indentLeft);
    set("indentRight", formatting?.indentRight);
    set("indentFirstLine", formatting?.indentFirstLine);
    set("hangingIndent", formatting?.hangingIndent);
    set("borders", formatting?.borders);
    set("shading", formatting?.shading);
    set("tabs", formatting?.tabs);

    // Page break control
    set("pageBreakBefore", formatting?.pageBreakBefore);
    set("keepNext", formatting?.keepNext);
    set("keepLines", formatting?.keepLines);
    set("runInWithNext", formatting?.runInWithNext);

    // Outline level
    set("outlineLevel", formatting?.outlineLevel);

    // Text direction
    set("bidi", formatting?.bidi);

    // Default run properties (pPr/rPr)
    set(
      "defaultTextFormatting",
      resolveTextFormatting(formatting?.runProperties, styleResolver),
    );
  }

  // Section break type and full section properties for layout + round-trip
  if (paragraph.sectionProperties) {
    attrs._sectionProperties = paragraph.sectionProperties;
    const st = paragraph.sectionProperties.sectionStart;
    if (
      st === "nextPage" ||
      st === "continuous" ||
      st === "oddPage" ||
      st === "evenPage"
    ) {
      attrs.sectionBreakType = st;
    }
  }
  if (paragraph.renderedPageBreakBefore) {
    attrs.renderedPageBreakBefore = true;
  }

  return attrs;
}

// ============================================================================
// TABLE CONVERSION
// ============================================================================

/**
 * Resolve table style conditional formatting
 */
function resolveTableStyleConditional(
  styleResolver: StyleEngine | null,
  tableStyleId: string | undefined,
  conditionType: string,
): { tcPr?: TableCellFormatting; rPr?: TextFormatting } | undefined {
  if (!styleResolver || !tableStyleId) {
    return undefined;
  }

  const style = styleResolver.getStyle(tableStyleId);
  if (!style?.tblStylePr) {
    return undefined;
  }

  const conditional = style.tblStylePr.find((p) => p.type === conditionType);
  if (!conditional) {
    return undefined;
  }

  const runPropsFromPpr = conditional.pPr?.runProperties
    ? resolveTextFormatting(conditional.pPr.runProperties, styleResolver)
    : undefined;
  const resolvedRpr = conditional.rPr
    ? resolveTextFormatting(conditional.rPr, styleResolver)
    : undefined;
  const mergedRunProps = mergeTextFormatting(runPropsFromPpr, resolvedRpr);

  const result: { tcPr?: TableCellFormatting; rPr?: TextFormatting } = {};
  if (conditional.tcPr) {
    result.tcPr = conditional.tcPr;
  }
  if (mergedRunProps) {
    result.rPr = mergedRunProps;
  }
  return result;
}

function resolveTableBaseStyle(
  styleResolver: StyleEngine | null,
  tableStyleId: string | undefined,
): { tcPr?: TableCellFormatting; rPr?: TextFormatting } | undefined {
  if (!styleResolver || !tableStyleId) {
    return undefined;
  }

  const style = styleResolver.getStyle(tableStyleId);
  if (!style) {
    return undefined;
  }

  const runPropsFromPpr = style.pPr?.runProperties
    ? resolveTextFormatting(style.pPr.runProperties, styleResolver)
    : undefined;
  const resolvedRpr = style.rPr
    ? resolveTextFormatting(style.rPr, styleResolver)
    : undefined;
  const mergedRunProps = mergeTextFormatting(runPropsFromPpr, resolvedRpr);

  const result: { tcPr?: TableCellFormatting; rPr?: TextFormatting } = {};
  if (style.tcPr) {
    result.tcPr = style.tcPr;
  }
  if (mergedRunProps) {
    result.rPr = mergedRunProps;
  }
  return result.tcPr || result.rPr ? result : undefined;
}

function mergeConditionalStyles(
  base?: { tcPr?: TableCellFormatting; rPr?: TextFormatting },
  override?: { tcPr?: TableCellFormatting; rPr?: TextFormatting },
): { tcPr?: TableCellFormatting; rPr?: TextFormatting } | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }

  const merged: { tcPr?: TableCellFormatting; rPr?: TextFormatting } = {};

  const baseTcPr = base.tcPr;
  const overrideTcPr = override.tcPr;
  if (baseTcPr || overrideTcPr) {
    const tcPr: TableCellFormatting = {
      ...baseTcPr,
      ...overrideTcPr,
    };

    if (baseTcPr?.borders || overrideTcPr?.borders) {
      tcPr.borders = {
        ...baseTcPr?.borders,
        ...overrideTcPr?.borders,
      };
    }

    if (baseTcPr?.shading || overrideTcPr?.shading) {
      tcPr.shading = {
        ...baseTcPr?.shading,
        ...overrideTcPr?.shading,
      };
    }

    if (baseTcPr?.margins || overrideTcPr?.margins) {
      tcPr.margins = {
        ...baseTcPr?.margins,
        ...overrideTcPr?.margins,
      };
    }

    merged.tcPr = tcPr;
  }

  const mergedRPr = mergeTextFormatting(base.rPr, override.rPr);
  if (mergedRPr) {
    merged.rPr = mergedRPr;
  }

  return merged;
}

function hasDirectRunFormatting(
  formatting: TextFormatting | undefined,
): boolean {
  if (!formatting) {
    return false;
  }

  const entries: [string, unknown][] = Object.entries(formatting);
  return entries.some(
    ([key, value]) => key !== "styleId" && value !== undefined,
  );
}

function stripParagraphMarkOnlyFormatting(
  formatting: TextFormatting,
): TextFormatting | undefined {
  const { highlight: _h, shading: _s, ...rest } = formatting;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function suppressParagraphMarkFormatting(
  base: TextFormatting | undefined,
  paragraphMark: TextFormatting | undefined,
  direct: TextFormatting | undefined,
): TextFormatting | undefined {
  if (!paragraphMark) {
    return base;
  }

  const result: TextFormatting = { ...base };
  suppressBooleanParagraphMark(result, paragraphMark, direct, "bold");
  suppressBooleanParagraphMark(result, paragraphMark, direct, "italic");
  suppressBooleanParagraphMark(result, paragraphMark, direct, "strike");
  suppressBooleanParagraphMark(result, paragraphMark, direct, "doubleStrike");
  suppressBooleanParagraphMark(result, paragraphMark, direct, "allCaps");
  suppressBooleanParagraphMark(result, paragraphMark, direct, "smallCaps");
  suppressBooleanParagraphMark(result, paragraphMark, direct, "hidden");
  suppressBooleanParagraphMark(result, paragraphMark, direct, "emboss");
  suppressBooleanParagraphMark(result, paragraphMark, direct, "imprint");
  suppressBooleanParagraphMark(result, paragraphMark, direct, "shadow");
  suppressBooleanParagraphMark(result, paragraphMark, direct, "outline");
  suppressBooleanParagraphMark(result, paragraphMark, direct, "rtl");

  if (
    paragraphMark.underline !== undefined &&
    direct?.underline === undefined
  ) {
    result.underline = { style: "none" };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function suppressBooleanParagraphMark(
  result: TextFormatting,
  paragraphMark: TextFormatting,
  direct: TextFormatting | undefined,
  key: keyof Pick<
    TextFormatting,
    | "bold"
    | "italic"
    | "strike"
    | "doubleStrike"
    | "allCaps"
    | "smallCaps"
    | "hidden"
    | "emboss"
    | "imprint"
    | "shadow"
    | "outline"
    | "rtl"
  >,
): void {
  if (paragraphMark[key] === undefined || direct?.[key] !== undefined) {
    return;
  }
  result[key] = false;
}

function resolveTextFormatting(
  formatting: TextFormatting | undefined,
  styleResolver: StyleEngine | null,
): TextFormatting | undefined {
  if (!formatting) {
    return styleResolver?.resolveRunStyle(null);
  }
  if (!styleResolver) {
    return formatting;
  }

  const styleFormatting = styleResolver.resolveRunStyle(formatting.styleId);
  return mergeTextFormatting(styleFormatting, formatting);
}

function resolveParagraphDefaultTextFormatting(
  styleId: string | undefined,
  formatting: Paragraph["formatting"] | undefined,
  styleResolver: StyleEngine,
): TextFormatting | undefined {
  const style = styleId
    ? (styleResolver.getStyle(styleId) ??
      styleResolver.getDefaultParagraphStyle())
    : styleResolver.getDefaultParagraphStyle();
  const paragraphStyleRpr = style?.type === "paragraph" ? style.rPr : undefined;
  // The pPr/rPr block describes the paragraph mark only — see the comment on
  // `stripParagraphMarkOnlyFormatting`. We must NOT route this through
  // `resolveTextFormatting` here, because that folds docDefaults back into
  // the run properties and then overwrites the paragraph style's font
  // (e.g. FootnoteText's Times New Roman) with the docDefault Calibri when
  // merged into the cascade below.
  const rawParagraphMarkRpr = formatting?.runProperties;
  const characterStyleRpr =
    rawParagraphMarkRpr?.styleId !== undefined
      ? styleResolver.getRunStyleOwnProperties(rawParagraphMarkRpr.styleId)
      : undefined;
  const paragraphRunProperties = rawParagraphMarkRpr
    ? stripParagraphMarkOnlyFormatting(
        mergeTextFormatting(characterStyleRpr, rawParagraphMarkRpr) ?? {},
      )
    : undefined;

  return mergeTextFormatting(
    mergeTextFormatting(
      mergeTextFormatting(
        styleResolver.getDocDefaults()?.rPr,
        styleResolver.getDefaultCharacterStyle()?.rPr,
      ),
      paragraphStyleRpr,
    ),
    paragraphRunProperties,
  );
}

/**
 * Convert a Table to a ProseMirror table node
 *
 * Handles column widths from w:tblGrid - if cell widths aren't specified,
 * we use the grid column widths to set cell widths. This ensures tables
 * preserve their layout when opened from DOCX files.
 */
/**
 * Calculate rowSpan values from vMerge attributes.
 * OOXML uses vMerge="restart" to start a vertical merge and vMerge="continue" for cells that should be merged.
 * This function converts that to rowSpan values and marks which cells should be skipped.
 */
type RowSpanInfo = {
  rowSpan: number;
  skip: boolean;
  preserveVMergeRestart?: boolean;
  continuationCells?: TableCell[];
};

function calculateRowSpans(table: Table): Map<string, RowSpanInfo> {
  const result = new Map<string, RowSpanInfo>();
  const numRows = table.rows.length;

  // Track active vertical merges per column (stores the row index where merge started)
  const activeMerges = new Map<number, number>();

  // Process each row
  for (let rowIndex = 0; rowIndex < numRows; rowIndex++) {
    // SAFETY: rowIndex < numRows <= table.rows.length
    const row = table.rows[rowIndex]!;
    if (row.cells.length === 0) {
      clearActiveVerticalMerges(activeMerges, result);
      continue;
    }
    let colIndex = 0;
    const rowCells = row.cells.map((cell) => {
      const colspan = cell.formatting?.gridSpan ?? 1;
      const vMerge = cell.formatting?.vMerge;
      const startRow =
        vMerge === "continue" ? activeMerges.get(colIndex) : undefined;
      const info = {
        cell,
        colIndex,
        colspan,
        vMerge,
        startRow,
        hasMeaningfulContent: tableCellHasMeaningfulContent(cell),
        shouldSkip: vMerge === "continue" && startRow !== undefined,
      };
      colIndex += colspan;
      return info;
    });
    const rowWouldBeEmpty =
      rowCells.length > 0 && rowCells.every((cell) => cell.shouldSkip);

    for (const cellInfo of rowCells) {
      const {
        colIndex: cellColIndex,
        vMerge,
        startRow,
        hasMeaningfulContent,
      } = cellInfo;
      const key = `${rowIndex}-${cellColIndex}`;

      if (vMerge === "restart") {
        // Start of a new vertical merge
        activeMerges.set(cellColIndex, rowIndex);
        result.set(key, { rowSpan: 1, skip: false });
      } else if (vMerge === "continue") {
        // Continuation of a merge - only skip it when the parsed grid has a
        // matching restart in this exact column and the continuation is only a
        // structural placeholder. Real DOCX tables can be ragged, and some
        // continuation cells contain drawings or other payload that must not be
        // merged away.
        if (startRow === undefined || rowWouldBeEmpty || hasMeaningfulContent) {
          result.set(key, { rowSpan: 1, skip: false });
          if (
            (rowWouldBeEmpty || hasMeaningfulContent) &&
            startRow !== undefined
          ) {
            const restartCell = result.get(`${startRow}-${cellColIndex}`);
            if (restartCell) {
              restartCell.preserveVMergeRestart = true;
            }
            activeMerges.delete(cellColIndex);
          }
          continue;
        }

        // Increment rowSpan of the starting cell
        const startKey = `${startRow}-${cellColIndex}`;
        const startCell = result.get(startKey);
        if (startCell) {
          startCell.rowSpan++;
          startCell.continuationCells ??= [];
          startCell.continuationCells.push(cellInfo.cell);
        }
        result.set(key, { rowSpan: 1, skip: true });
      } else {
        // No vMerge - clear any active merge for this column
        activeMerges.delete(cellColIndex);
        result.set(key, { rowSpan: 1, skip: false });
      }
    }
  }

  return result;
}

function clearActiveVerticalMerges(
  activeMerges: Map<number, number>,
  result: Map<string, RowSpanInfo>,
): void {
  for (const [colIndex, startRow] of activeMerges) {
    const restartCell = result.get(`${startRow}-${colIndex}`);
    if (restartCell) {
      restartCell.preserveVMergeRestart = true;
    }
  }
  activeMerges.clear();
}

function tableCellHasMeaningfulContent(cell: TableCell): boolean {
  return cell.content.some(blockHasMeaningfulContent);
}

function blockHasMeaningfulContent(block: Paragraph | Table): boolean {
  if (block.type === "table") {
    return block.rows.some((row) =>
      row.cells.some((cell) => tableCellHasMeaningfulContent(cell)),
    );
  }

  return block.content.some(paragraphContentHasMeaningfulContent);
}

function paragraphContentHasMeaningfulContent(
  content: Paragraph["content"][number],
): boolean {
  if (content.type === "run") {
    return content.content.length > 0;
  }
  if (content.type === "hyperlink") {
    return content.children.some(paragraphContentHasMeaningfulContent);
  }
  if (
    content.type === "insertion" ||
    content.type === "deletion" ||
    content.type === "moveFrom" ||
    content.type === "moveTo"
  ) {
    return content.content.some(paragraphContentHasMeaningfulContent);
  }
  return true;
}

function convertTable(
  table: Table,
  styleResolver: StyleEngine | null,
  theme: Theme | null | undefined,
): PMNode {
  // Calculate rowSpan values from vMerge
  const rowSpanMap = calculateRowSpans(table);

  // Get column widths from table grid
  const columnWidths = table.columnWidths;

  // Calculate total width from columnWidths if available (for percentage calculation)
  const totalWidth = columnWidths?.reduce((sum, w) => sum + w, 0) ?? 0;

  // Get the table style's conditional formatting
  const tableStyleId = table.formatting?.styleId;
  const look = table.formatting?.look;

  // Resolve table borders through inline style, table style, then default table style.
  const tableStyle = tableStyleId
    ? styleResolver?.getStyle(tableStyleId)
    : undefined;
  const defaultTableStyle = styleResolver?.getDefaultTableStyle();
  const fallbackTableStyle = tableStyleId ? undefined : defaultTableStyle;
  const conditionalTableStyleId =
    tableStyle?.styleId ?? fallbackTableStyle?.styleId;
  const resolvedTableBorders =
    table.formatting?.borders ??
    tableStyle?.tblPr?.borders ??
    fallbackTableStyle?.tblPr?.borders;

  // Resolve default cell margins through the same table-style cascade.
  const tableCellMargins =
    table.formatting?.cellMargins ??
    tableStyle?.tblPr?.cellMargins ??
    fallbackTableStyle?.tblPr?.cellMargins;
  let cellMarginsAttr:
    | { top?: number; bottom?: number; left?: number; right?: number }
    | undefined;
  if (tableCellMargins) {
    const m: { top?: number; bottom?: number; left?: number; right?: number } =
      {};
    if (tableCellMargins.top?.value !== undefined) {
      m.top = tableCellMargins.top.value;
    }
    if (tableCellMargins.bottom?.value !== undefined) {
      m.bottom = tableCellMargins.bottom.value;
    }
    if (tableCellMargins.left?.value !== undefined) {
      m.left = tableCellMargins.left.value;
    }
    if (tableCellMargins.right?.value !== undefined) {
      m.right = tableCellMargins.right.value;
    }
    cellMarginsAttr = m;
  }

  const attrs: TableAttrs = {};
  if (table.formatting?.styleId) {
    attrs.styleId = table.formatting.styleId;
  }
  if (table.formatting?.width?.value !== undefined) {
    attrs.width = table.formatting.width.value;
  }
  if (table.formatting?.width?.type) {
    attrs.widthType = table.formatting.width.type;
  }
  if (table.formatting?.justification) {
    attrs.justification = table.formatting.justification;
  }
  if (columnWidths) {
    attrs.columnWidths = columnWidths;
  }
  if (table.formatting?.floating) {
    attrs.floating = table.formatting.floating;
  }
  if (cellMarginsAttr) {
    attrs.cellMargins = cellMarginsAttr;
  }
  if (table.formatting?.look) {
    attrs.look = table.formatting.look;
  }
  if (table.formatting) {
    attrs._originalFormatting = table.formatting;
  }

  type CondStyle = { tcPr?: TableCellFormatting; rPr?: TextFormatting };
  const conditionalStyles: {
    wholeTable?: CondStyle;
    firstRow?: CondStyle;
    lastRow?: CondStyle;
    firstCol?: CondStyle;
    lastCol?: CondStyle;
    band1Horz?: CondStyle;
    band2Horz?: CondStyle;
    band1Vert?: CondStyle;
    band2Vert?: CondStyle;
    nwCell?: CondStyle;
    neCell?: CondStyle;
    swCell?: CondStyle;
    seCell?: CondStyle;
  } = {};
  const setCS = (key: keyof typeof conditionalStyles, type: string): void => {
    const val = resolveTableStyleConditional(
      styleResolver,
      conditionalTableStyleId,
      type,
    );
    if (val) {
      conditionalStyles[key] = val;
    }
  };
  setCS("wholeTable", "wholeTable");
  const wholeTableStyle = mergeConditionalStyles(
    resolveTableBaseStyle(styleResolver, conditionalTableStyleId),
    conditionalStyles.wholeTable,
  );
  if (wholeTableStyle) {
    conditionalStyles.wholeTable = wholeTableStyle;
  }
  setCS("firstRow", "firstRow");
  setCS("lastRow", "lastRow");
  setCS("firstCol", "firstCol");
  setCS("lastCol", "lastCol");
  setCS("band1Horz", "band1Horz");
  setCS("band2Horz", "band2Horz");
  setCS("band1Vert", "band1Vert");
  setCS("band2Vert", "band2Vert");
  setCS("nwCell", "nwCell");
  setCS("neCell", "neCell");
  setCS("swCell", "swCell");
  setCS("seCell", "seCell");

  const bandingEnabledH = look?.noHBand !== true;
  const bandingEnabledV = look?.noVBand !== true;

  // Track data row index (excluding header rows) for banding
  let dataRowIndex = 0;
  const totalRows = table.rows.length;
  const gridColumnCount = columnWidths?.length ?? 0;
  const totalColumns =
    gridColumnCount > 0 ? gridColumnCount : countTableColumns(table.rows);
  const rows = table.rows.map((row, rowIndex) => {
    // Conditional formatting flag: firstRow in tblLook means "apply first-row styling"
    const isFirstRowStyled = rowIndex === 0 && !!look?.firstRow;
    const isLastRow = rowIndex === totalRows - 1 && !!look?.lastRow;

    const rowBandStyle = (() => {
      if (bandingEnabledH && !isFirstRowStyled && !isLastRow) {
        return (() => {
          if (dataRowIndex % 2 === 0) {
            return conditionalStyles.band1Horz;
          }
          return conditionalStyles.band2Horz;
        })();
      }
      return undefined;
    })();
    if (bandingEnabledH && !isFirstRowStyled && !isLastRow) {
      dataRowIndex++;
    }

    return convertTableRow(
      row,
      styleResolver,
      isFirstRowStyled,
      columnWidths,
      totalWidth,
      conditionalStyles,
      rowBandStyle,
      bandingEnabledV,
      look,
      resolvedTableBorders, // Pass resolved table borders (own or from style)
      rowIndex,
      totalRows,
      totalColumns,
      rowSpanMap,
      cellMarginsAttr,
      theme,
    );
  });

  return schema.node("table", attrs, rows);
}

function countTableColumns(rows: TableRow[]): number {
  let maxColumns = 0;
  for (const row of rows) {
    let rowColumns = 0;
    for (const cell of row.cells) {
      rowColumns += cell.formatting?.gridSpan ?? 1;
    }
    maxColumns = Math.max(maxColumns, rowColumns);
  }
  return maxColumns;
}

/**
 * Convert a TableRow to a ProseMirror table row node
 */
function convertTableRow(
  row: TableRow,
  styleResolver: StyleEngine | null,
  isHeaderRow: boolean,
  columnWidths?: number[],
  totalWidth?: number,
  conditionalStyles?: {
    wholeTable?: { tcPr?: TableCellFormatting; rPr?: TextFormatting };
    firstRow?: { tcPr?: TableCellFormatting; rPr?: TextFormatting };
    lastRow?: { tcPr?: TableCellFormatting; rPr?: TextFormatting };
    firstCol?: { tcPr?: TableCellFormatting; rPr?: TextFormatting };
    lastCol?: { tcPr?: TableCellFormatting; rPr?: TextFormatting };
    band1Horz?: { tcPr?: TableCellFormatting; rPr?: TextFormatting };
    band2Horz?: { tcPr?: TableCellFormatting; rPr?: TextFormatting };
    band1Vert?: { tcPr?: TableCellFormatting; rPr?: TextFormatting };
    band2Vert?: { tcPr?: TableCellFormatting; rPr?: TextFormatting };
    nwCell?: { tcPr?: TableCellFormatting; rPr?: TextFormatting };
    neCell?: { tcPr?: TableCellFormatting; rPr?: TextFormatting };
    swCell?: { tcPr?: TableCellFormatting; rPr?: TextFormatting };
    seCell?: { tcPr?: TableCellFormatting; rPr?: TextFormatting };
  },
  rowBandStyle?: { tcPr?: TableCellFormatting; rPr?: TextFormatting },
  bandingEnabledV?: boolean,
  tableLook?: TableLook,
  tableBorders?: TableBorders,
  rowIndex?: number,
  totalRows?: number,
  totalColumns?: number,
  rowSpanMap?: Map<string, RowSpanInfo>,
  defaultCellMargins?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  },
  theme?: Theme | null,
): PMNode {
  const attrs: TableRowAttrs = {
    // isHeader controls header row REPETITION on page breaks.
    // Only w:tblHeader (row.formatting.header) should trigger this — NOT tblLook/firstRow
    // which is purely a conditional formatting flag (ECMA-376 §17.7.6.1).
    isHeader: !!row.formatting?.header,
  };
  if (row.formatting?.height?.value !== undefined) {
    attrs.height = row.formatting.height.value;
  }
  if (row.formatting?.heightRule) {
    attrs.heightRule = row.formatting.heightRule;
  }
  if (row.formatting) {
    attrs._originalFormatting = row.formatting;
  }

  const numCells = row.cells.length;
  const isFirstRow = rowIndex === 0;
  const isLastRow = rowIndex === (totalRows ?? 1) - 1;
  const rowCnf = row.formatting?.conditionalFormat;
  const rowIsFirstRow = rowCnf?.firstRow ?? isFirstRow;
  const rowIsLastRow = rowCnf?.lastRow ?? isLastRow;
  const totalCols =
    totalColumns != null && totalColumns > 0
      ? totalColumns
      : Math.max(numCells, 1);

  // A literal `<w:tr/>` from a non-Word producer parses with zero cells. PM's
  // tableRow content is `(tableCell | tableHeader)+`, so emit one placeholder
  // cell spanning the table's grid width to keep the row valid.
  let effectiveCells: TableCell[] = row.cells;
  if (effectiveCells.length === 0) {
    const fallback: TableCell = {
      type: "tableCell",
      content: [{ type: "paragraph", content: [] }],
    };
    if (totalCols > 1) {
      fallback.formatting = { gridSpan: totalCols };
    }
    effectiveCells = [fallback];
  }

  // Track column index for mapping to columnWidths (accounting for colspan)
  let colIndex = 0;
  const cells: PMNode[] = [];

  for (const cellIndex_item of effectiveCells) {
    const cell = cellIndex_item;
    const colspan = cell.formatting?.gridSpan ?? 1;

    // Check if this cell should be skipped (it's a vMerge continue cell)
    const rowSpanKey = `${rowIndex ?? 0}-${colIndex}`;
    const rowSpanInfo = rowSpanMap?.get(rowSpanKey);
    const shouldSkip = rowSpanInfo?.skip ?? false;
    const calculatedRowSpan = rowSpanInfo?.rowSpan ?? 1;
    const preserveVMergeRestart = rowSpanInfo?.preserveVMergeRestart ?? false;

    // Calculate the width for this cell from columnWidths if cell doesn't have own width
    let gridWidth: number | undefined;
    if (columnWidths && totalWidth && totalWidth > 0) {
      // Sum widths for all columns this cell spans
      let cellWidthTwips = 0;
      for (let i = 0; i < colspan && colIndex + i < columnWidths.length; i++) {
        cellWidthTwips += columnWidths[colIndex + i] ?? 0;
      }
      // Convert to percentage of total table width
      gridWidth = Math.round((cellWidthTwips / totalWidth) * 100);
    }
    colIndex += colspan;

    // Skip cells that are part of a vertical merge (vMerge="continue")
    if (shouldSkip) {
      continue;
    }

    // Determine cell position for table border application
    const isFirstCol = colIndex - colspan === 0;
    const isLastCol = colIndex === totalCols;
    const cellCnf = cell.formatting?.conditionalFormat;
    const cellIsFirstRow = cellCnf?.firstRow ?? rowIsFirstRow;
    const cellIsLastRow = cellCnf?.lastRow ?? rowIsLastRow;
    const cellIsFirstCol = cellCnf?.firstColumn ?? isFirstCol;
    const cellIsLastCol = cellCnf?.lastColumn ?? isLastCol;

    // Determine vertical banding style based on column index
    let vertBandStyle:
      | { tcPr?: TableCellFormatting; rPr?: TextFormatting }
      | undefined;
    if (bandingEnabledV) {
      const firstColOffset = tableLook?.firstColumn ? 1 : 0;
      const bandColIndex = colIndex - colspan - firstColOffset;
      const isEligible =
        bandColIndex >= 0 &&
        !(tableLook?.lastColumn && cellIsLastCol) &&
        !(tableLook?.firstColumn && cellIsFirstCol);
      if (isEligible) {
        vertBandStyle =
          bandColIndex % 2 === 0
            ? conditionalStyles?.band1Vert
            : conditionalStyles?.band2Vert;
      }
    }

    if (cellCnf?.oddVBand) {
      vertBandStyle = conditionalStyles?.band1Vert;
    } else if (cellCnf?.evenVBand) {
      vertBandStyle = conditionalStyles?.band2Vert;
    }

    let effectiveRowBandStyle = rowBandStyle;
    if (rowCnf?.oddHBand) {
      effectiveRowBandStyle = conditionalStyles?.band1Horz;
    } else if (rowCnf?.evenHBand) {
      effectiveRowBandStyle = conditionalStyles?.band2Horz;
    }
    if (cellCnf?.oddHBand) {
      effectiveRowBandStyle = conditionalStyles?.band1Horz;
    } else if (cellCnf?.evenHBand) {
      effectiveRowBandStyle = conditionalStyles?.band2Horz;
    }

    // Build conditional style precedence (wholeTable -> banding -> row/col -> corners)
    let cellConditionalStyle = conditionalStyles?.wholeTable;
    cellConditionalStyle = mergeConditionalStyles(
      cellConditionalStyle,
      effectiveRowBandStyle,
    );
    cellConditionalStyle = mergeConditionalStyles(
      cellConditionalStyle,
      vertBandStyle,
    );
    if (
      cellIsFirstRow &&
      (tableLook?.firstRow || rowCnf?.firstRow || cellCnf?.firstRow)
    ) {
      cellConditionalStyle = mergeConditionalStyles(
        cellConditionalStyle,
        conditionalStyles?.firstRow,
      );
    }
    if (
      cellIsLastRow &&
      (tableLook?.lastRow || rowCnf?.lastRow || cellCnf?.lastRow)
    ) {
      cellConditionalStyle = mergeConditionalStyles(
        cellConditionalStyle,
        conditionalStyles?.lastRow,
      );
    }
    if (
      cellIsFirstCol &&
      (tableLook?.firstColumn || rowCnf?.firstColumn || cellCnf?.firstColumn)
    ) {
      cellConditionalStyle = mergeConditionalStyles(
        cellConditionalStyle,
        conditionalStyles?.firstCol,
      );
    }
    if (
      cellIsLastCol &&
      (tableLook?.lastColumn || rowCnf?.lastColumn || cellCnf?.lastColumn)
    ) {
      cellConditionalStyle = mergeConditionalStyles(
        cellConditionalStyle,
        conditionalStyles?.lastCol,
      );
    }
    if (
      cellIsFirstRow &&
      cellIsFirstCol &&
      (tableLook?.firstRow || rowCnf?.firstRow || cellCnf?.firstRow) &&
      (tableLook?.firstColumn || rowCnf?.firstColumn || cellCnf?.firstColumn)
    ) {
      cellConditionalStyle = mergeConditionalStyles(
        cellConditionalStyle,
        conditionalStyles?.nwCell,
      );
    }
    if (
      cellIsFirstRow &&
      cellIsLastCol &&
      (tableLook?.firstRow || rowCnf?.firstRow || cellCnf?.firstRow) &&
      (tableLook?.lastColumn || rowCnf?.lastColumn || cellCnf?.lastColumn)
    ) {
      cellConditionalStyle = mergeConditionalStyles(
        cellConditionalStyle,
        conditionalStyles?.neCell,
      );
    }
    if (
      cellIsLastRow &&
      cellIsFirstCol &&
      (tableLook?.lastRow || rowCnf?.lastRow || cellCnf?.lastRow) &&
      (tableLook?.firstColumn || rowCnf?.firstColumn || cellCnf?.firstColumn)
    ) {
      cellConditionalStyle = mergeConditionalStyles(
        cellConditionalStyle,
        conditionalStyles?.swCell,
      );
    }
    if (
      cellIsLastRow &&
      cellIsLastCol &&
      (tableLook?.lastRow || rowCnf?.lastRow || cellCnf?.lastRow) &&
      (tableLook?.lastColumn || rowCnf?.lastColumn || cellCnf?.lastColumn)
    ) {
      cellConditionalStyle = mergeConditionalStyles(
        cellConditionalStyle,
        conditionalStyles?.seCell,
      );
    }

    cells.push(
      convertTableCell(
        cell,
        styleResolver,
        isHeaderRow,
        gridWidth,
        cellConditionalStyle,
        tableBorders,
        isFirstRow,
        isLastRow,
        isFirstCol,
        isLastCol,
        calculatedRowSpan,
        preserveVMergeRestart,
        rowSpanInfo?.continuationCells,
        defaultCellMargins,
        theme,
      ),
    );
  }

  return schema.node("tableRow", attrs, cells);
}

const TABLE_BORDER_SIDES = [
  "top",
  "bottom",
  "left",
  "right",
  "insideH",
  "insideV",
] as const satisfies readonly (keyof TableBorders)[];

function resolveThemedBorderColors(
  borders: TableBorders | undefined,
  theme: Theme | null | undefined,
): TableBorders | undefined {
  if (!borders || !theme?.colorScheme) {
    return borders;
  }

  let resolved: TableBorders | undefined;
  for (const side of TABLE_BORDER_SIDES) {
    const border = borders[side];
    if (!border?.color?.themeColor || border.color.auto) {
      continue;
    }

    resolved ??= { ...borders };
    resolved[side] = {
      ...border,
      color: {
        rgb: resolveColor(border.color, theme).replace(/^#/u, ""),
      },
    };
  }

  return resolved ?? borders;
}

/**
 * Convert a TableCell to a ProseMirror table cell node
 */
function convertTableCell(
  cell: TableCell,
  styleResolver: StyleEngine | null,
  isHeader: boolean,
  gridWidthPercent?: number,
  conditionalStyle?: { tcPr?: TableCellFormatting; rPr?: TextFormatting },
  tableBorders?: TableBorders,
  isFirstRow?: boolean,
  isLastRow?: boolean,
  isFirstCol?: boolean,
  isLastCol?: boolean,
  calculatedRowSpan?: number,
  preserveVMergeRestart?: boolean,
  vMergeContinuationCells?: TableCell[],
  defaultCellMargins?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  },
  theme?: Theme | null,
): PMNode {
  const formatting = cell.formatting;

  // Use the pre-calculated rowSpan from vMerge analysis
  const rowspan = calculatedRowSpan ?? 1;

  // Determine width: prefer cell's own width, fall back to grid width
  let width = formatting?.width?.value;
  let widthType = formatting?.width?.type;

  // If cell doesn't have its own width, use the grid-calculated percentage
  if (width === undefined && gridWidthPercent !== undefined) {
    width = gridWidthPercent;
    widthType = "pct";
  }

  // Determine background color: prefer cell's own shading, fall back to conditional style
  const backgroundColor =
    formatting?.shading?.fill?.rgb ??
    conditionalStyle?.tcPr?.shading?.fill?.rgb;

  // Convert borders — preserve full BorderSpec per side
  // Priority: cell borders > conditional style borders > table borders
  const baseBorders = (() => {
    if (tableBorders) {
      return {
        top: isFirstRow ? tableBorders.top : tableBorders.insideH,
        bottom: isLastRow ? tableBorders.bottom : tableBorders.insideH,
        left: isFirstCol ? tableBorders.left : tableBorders.insideV,
        right: isLastCol ? tableBorders.right : tableBorders.insideV,
      };
    }
    return undefined;
  })();

  const conditionalBorders = conditionalStyle?.tcPr?.borders;
  const cellBorders = formatting?.borders;

  const borders = resolveThemedBorderColors(
    baseBorders || conditionalBorders || cellBorders
      ? {
          ...baseBorders,
          ...conditionalBorders,
          ...cellBorders,
        }
      : undefined,
    theme,
  );

  // Helper to build margins object without undefined values
  const buildMarginsAttr = (src: {
    top?: { value: number };
    bottom?: { value: number };
    left?: { value: number };
    right?: { value: number };
  }): { top?: number; bottom?: number; left?: number; right?: number } => {
    const m: { top?: number; bottom?: number; left?: number; right?: number } =
      {};
    if (src.top?.value !== undefined) {
      m.top = src.top.value;
    }
    if (src.bottom?.value !== undefined) {
      m.bottom = src.bottom.value;
    }
    if (src.left?.value !== undefined) {
      m.left = src.left.value;
    }
    if (src.right?.value !== undefined) {
      m.right = src.right.value;
    }
    return m;
  };

  const attrs: TableCellAttrs = {
    colspan: formatting?.gridSpan ?? 1,
    rowspan,
  };
  if (width !== undefined) {
    attrs.width = width;
  }
  if (widthType) {
    attrs.widthType = widthType;
  }
  if (formatting?.verticalAlign) {
    attrs.verticalAlign = formatting.verticalAlign;
  }
  if (backgroundColor) {
    attrs.backgroundColor = backgroundColor;
  }
  if (formatting?.textDirection) {
    attrs.textDirection = formatting.textDirection;
  }
  if (formatting?.noWrap !== undefined) {
    attrs.noWrap = formatting.noWrap;
  }
  if (borders) {
    attrs.borders = borders;
  }
  if (formatting?.margins) {
    attrs.margins = buildMarginsAttr(formatting.margins);
  } else if (conditionalStyle?.tcPr?.margins) {
    attrs.margins = buildMarginsAttr(conditionalStyle.tcPr.margins);
  } else if (defaultCellMargins) {
    attrs.margins = defaultCellMargins;
  }
  if (formatting) {
    attrs._originalFormatting = formatting;
  }
  if (preserveVMergeRestart) {
    attrs._preserveVMergeRestart = true;
  }
  if (vMergeContinuationCells && vMergeContinuationCells.length > 0) {
    attrs._docxVMergeContinuationCells = vMergeContinuationCells;
  }

  // Convert cell content (paragraphs and nested tables)
  const contentNodes: PMNode[] = [];
  for (const content of cell.content) {
    if (content.type === "paragraph") {
      contentNodes.push(
        convertParagraph(
          content,
          styleResolver,
          undefined,
          conditionalStyle?.rPr,
        ),
      );
    } else {
      // Nested tables - recursively convert
      contentNodes.push(convertTable(content, styleResolver, theme));
    }
  }

  // Ensure cell has at least one paragraph
  if (contentNodes.length === 0) {
    contentNodes.push(schema.node("paragraph", {}, []));
  }

  // Use tableHeader for header cells, tableCell otherwise
  const nodeType = isHeader ? "tableHeader" : "tableCell";
  return schema.node(nodeType, attrs, contentNodes);
}

/**
 * Convert a SimpleField or ComplexField to a ProseMirror field node.
 * Preserves run formatting (bold, fontSize, color, etc.) as PM marks.
 * Accepts a run formatting resolver so fields inherit paragraph-level
 * formatting the same way regular text runs do.
 */
function convertField(
  field: SimpleField | ComplexField,
  getInheritedRunFormatting: RunFormattingResolver,
): PMNode | null {
  // Extract display text and formatting from field content/result
  let displayText = "";
  let fieldFormatting: TextFormatting | undefined;
  const runs = field.type === "simpleField" ? field.content : field.fieldResult;
  for (const r of runs) {
    if (r.type === "run") {
      for (const c of r.content) {
        if (c.type === "text") {
          displayText += c.text;
        }
      }
      // Use formatting from the first run that has it
      if (!fieldFormatting && r.formatting) {
        fieldFormatting = r.formatting;
      }
    }
  }

  // Merge style formatting with field run formatting (inline takes precedence)
  const inheritedFormatting = getInheritedRunFormatting(fieldFormatting);
  const mergedFormatting = mergeTextFormatting(
    inheritedFormatting,
    fieldFormatting,
  );
  const marks = textFormattingToMarks(mergedFormatting);

  return schema.node(
    "field",
    {
      fieldType: field.fieldType,
      instruction: field.instruction,
      displayText,
      fieldKind: field.type === "simpleField" ? "simple" : "complex",
      fldLock: field.fldLock ?? false,
      dirty: field.dirty ?? false,
    },
    undefined,
    marks,
  );
}

/**
 * Convert a MathEquation to a ProseMirror math node.
 */
function convertMathEquation(math: MathEquation): PMNode | null {
  return schema.node("math", {
    display: math.display,
    ommlXml: math.ommlXml,
    plainText: math.plainText || "",
  });
}

/**
 * Convert an InlineSdt to a ProseMirror sdt node with inline content.
 */
function convertInlineSdt(
  sdt: InlineSdt,
  getInheritedRunFormatting: RunFormattingResolver,
  styleResolver?: StyleEngine | null,
): PMNode | null {
  const props = sdt.properties;
  const inlineNodes: PMNode[] = [];
  let hyperlinkIndex = 0;

  for (const content of sdt.content) {
    if (content.type === "run") {
      const runNodes = convertRun(
        content,
        getInheritedRunFormatting(content.formatting),
        styleResolver,
      );
      inlineNodes.push(...runNodes);
    } else if (content.type === "hyperlink") {
      const currentHyperlinkIndex = hyperlinkIndex;
      hyperlinkIndex += 1;
      const linkNodes = convertHyperlink(
        content,
        getInheritedRunFormatting,
        styleResolver,
        currentHyperlinkIndex,
      );
      inlineNodes.push(...linkNodes);
    } else if (
      content.type === "simpleField" ||
      content.type === "complexField"
    ) {
      const fieldNode = convertField(content, getInheritedRunFormatting);
      if (fieldNode) {
        inlineNodes.push(fieldNode);
      }
    } else if (content.type === "inlineSdt") {
      const nestedSdt = convertInlineSdt(
        content,
        getInheritedRunFormatting,
        styleResolver,
      );
      if (nestedSdt) {
        inlineNodes.push(nestedSdt);
      }
    } else {
      // content.type === "mathEquation" — narrowed by exhaustion of the
      // InlineSdt['content'] union above.
      const mathNode = convertMathEquation(content);
      if (mathNode) {
        inlineNodes.push(mathNode);
      }
    }
  }

  return schema.node(
    "sdt",
    {
      sdtType: props.sdtType,
      alias: props.alias ?? null,
      tag: props.tag ?? null,
      lock: props.lock ?? null,
      placeholder: props.placeholder ?? null,
      showingPlaceholder: props.showingPlaceholder ?? false,
      dateFormat: props.dateFormat ?? null,
      dateValueISO: props.dateValueISO ?? null,
      listItems: props.listItems ? JSON.stringify(props.listItems) : null,
      checked: props.checked ?? null,
    },
    inlineNodes.length > 0 ? inlineNodes : undefined,
  );
}

/**
 * Convert a Run to ProseMirror text nodes with marks
 *
 * @param run - The run to convert
 * @param styleFormatting - Text formatting from the paragraph's style (e.g., Heading1's font size/color)
 */
function convertRun(
  run: Run,
  styleFormatting?: TextFormatting,
  styleResolver?: StyleEngine | null,
): PMNode[] {
  const nodes: PMNode[] = [];

  // Merge style formatting with run's inline formatting
  // Inline formatting takes precedence over style formatting
  //
  // Use getRunStyleOwnProperties (not resolveRunStyle) to avoid docDefaults
  // from the character style overriding paragraph style properties.
  // The styleFormatting parameter already includes docDefaults from paragraph
  // style resolution, so we only need the character style's own properties.
  const runStyleFormatting = run.formatting?.styleId
    ? styleResolver?.getRunStyleOwnProperties(run.formatting.styleId)
    : undefined;
  const mergedFormatting = mergeTextFormatting(
    mergeTextFormatting(styleFormatting, runStyleFormatting),
    run.formatting,
  );
  const marks = textFormattingToMarks(mergedFormatting);

  for (const content of run.content) {
    const contentNodes = convertRunContent(content, marks);
    nodes.push(...contentNodes);
  }

  return nodes;
}

/**
 * Convert RunContent to ProseMirror nodes
 */
function convertRunContent(
  content: RunContent,
  marks: ReturnType<typeof schema.mark>[],
): PMNode[] {
  switch (content.type) {
    case "text":
      if (content.text) {
        return [schema.text(content.text, marks)];
      }
      return [];

    case "break":
      if (content.breakType === "textWrapping" || !content.breakType) {
        return [withHyperlinkBoundaryMarks(schema.node("hardBreak"), marks)];
      }
      if (content.breakType === "column") {
        return [
          withHyperlinkBoundaryMarks(
            schema.node("hardBreak", { breakType: "column" }),
            marks,
          ),
        ];
      }
      // Page breaks are represented as block separators by paragraphPageBreakPosition.
      return [];

    case "tab":
      // Convert to tab node for proper rendering. Keep the run marks because
      // Word commonly represents signature blanks as underlined tab runs.
      return [schema.node("tab").mark(marks)];

    case "drawing":
      return [
        withHyperlinkBoundaryMarks(
          convertImage(content.image, content.rawXml),
          marks,
        ),
      ];

    case "shape": {
      // Shapes with text body are handled as text boxes at block level
      // Other shapes render as inline SVG
      const shp = content.shape;
      if (shp.textBody) {
        // Skip - handled by extractTextBoxesFromParagraph
        return [];
      }
      return [withHyperlinkBoundaryMarks(convertShape(shp), marks)];
    }

    case "footnoteRef": {
      // Footnote reference - render as superscript number with footnoteRef mark
      const footnoteMark = schema.mark("footnoteRef", {
        id: content.id.toString(),
        noteType: "footnote",
      });
      return [schema.text(content.id.toString(), [...marks, footnoteMark])];
    }

    case "endnoteRef": {
      // Endnote reference - render as superscript number with footnoteRef mark
      const endnoteMark = schema.mark("footnoteRef", {
        id: content.id.toString(),
        noteType: "endnote",
      });
      return [schema.text(content.id.toString(), [...marks, endnoteMark])];
    }

    case "fieldChar":
    case "instrText":
      // Complex field structure markers — handled at the run/paragraph
      // level via `convertField`, not as standalone inline content.
      return [];

    case "noBreakHyphen":
      return [schema.text("‑", marks)];

    case "softHyphen":
      return [schema.text("­", marks)];

    case "symbol":
      // Plain Unicode symbol — fall through to text if the parsed
      // character is available; otherwise drop.
      return content.char ? [schema.text(content.char, marks)] : [];
  }
}

function withHyperlinkBoundaryMarks(
  node: PMNode,
  marks: ReturnType<typeof schema.mark>[],
): PMNode {
  if (!marks.some((mark) => mark.type.name === "hyperlink")) {
    return node;
  }

  return node.mark(marks);
}

/**
 * Convert an Image to a ProseMirror image node
 *
 * DOCX images have size in EMUs (English Metric Units), which must be
 * converted to pixels for proper HTML rendering.
 * 914400 EMU = 1 inch = 96 CSS pixels
 *
 * Image types in DOCX:
 * 1. Inline (wp:inline) - flows with text like a character
 * 2. Floating/Anchored (wp:anchor) with wrap types:
 *    - Square/Tight/Through: text wraps around image
 *      - wrapText='left' → text on LEFT, image floats RIGHT
 *      - wrapText='right' → text on RIGHT, image floats LEFT
 *      - wrapText='bothSides' → depends on horizontal alignment
 *    - TopAndBottom: image on its own line, text above/below only
 *    - None/Behind/InFront: positioned image, no text wrap
 */
type PartialImagePosition = Partial<NonNullable<Image["position"]>>;
type PartialImageSize = Partial<Image["size"]>;

function convertImage(image: Image, rawXml?: string): PMNode {
  // Convert EMU to pixels for proper sizing
  const imageData: { size?: PartialImageSize } = image;
  const imageSize = imageData.size;
  const widthPx = imageSize?.width ? emuToPixels(imageSize.width) : undefined;
  const heightPx = imageSize?.height
    ? emuToPixels(imageSize.height)
    : undefined;

  // Determine wrap type and float direction
  const wrapType = image.wrap.type;
  const wrapText = image.wrap.wrapText;
  const imagePosition: PartialImagePosition | undefined = image.position;
  const hAlign = imagePosition?.horizontal?.alignment;

  // Determine CSS float based on wrap settings
  // In DOCX: wrapText='left' means "text flows on the left" → image is on right → float: right
  //          wrapText='right' means "text flows on the right" → image is on left → float: left
  let cssFloat: "left" | "right" | "none" | undefined;

  if (wrapType === "inline") {
    cssFloat = "none"; // Inline images don't float
  } else if (wrapType === "topAndBottom") {
    cssFloat = "none"; // Block images don't float
  } else if (
    wrapType === "square" ||
    wrapType === "tight" ||
    wrapType === "through"
  ) {
    // These wrap types support text wrapping around the image
    if (wrapText === "left") {
      cssFloat = "right"; // Text on left → image floats right
    } else if (wrapText === "right") {
      cssFloat = "left"; // Text on right → image floats left
    } else {
      // bothSides, largest, or any other wrapText value:
      // use horizontal alignment to determine float
      if (hAlign === "left") {
        cssFloat = "left";
      } else if (hAlign === "right") {
        cssFloat = "right";
      } else {
        cssFloat = "none"; // Center or no alignment → block
      }
    }
  } else {
    // Behind, inFront, etc. - positioned images, no float
    cssFloat = "none";
  }

  // Determine display mode for CSS.
  //
  // - inline           → inline run, participates in flow
  // - topAndBottom     → block image, takes its own line
  // - behind / inFront → float (anchored at absolute coords; the page-level
  //   layer paints them, so they must be lifted out of the paragraph flow
  //   even though they don't carve a text-wrap exclusion zone)
  // - square / tight / through with cssFloat → float
  // - everything else (centered etc.) → block
  let displayMode: "inline" | "block" | "float";
  if (wrapType === "inline") {
    displayMode = "inline";
  } else if (wrapType === "topAndBottom") {
    displayMode = "block";
  } else if (wrapType === "behind" || wrapType === "inFront") {
    displayMode = "float";
  } else if (cssFloat !== "none") {
    displayMode = "float";
  } else {
    displayMode = "block";
  }

  // Build transform string if needed (rotation, flip)
  let transform: string | undefined;
  if (image.transform) {
    const transforms: string[] = [];
    if (image.transform.rotation) {
      transforms.push(`rotate(${image.transform.rotation}deg)`);
    }
    if (image.transform.flipH) {
      transforms.push("scaleX(-1)");
    }
    if (image.transform.flipV) {
      transforms.push("scaleY(-1)");
    }
    if (transforms.length > 0) {
      transform = transforms.join(" ");
    }
  }

  // Convert wrap distances from EMU to pixels for margins
  const distTop = image.wrap.distT ? emuToPixels(image.wrap.distT) : undefined;
  const distBottom = image.wrap.distB
    ? emuToPixels(image.wrap.distB)
    : undefined;
  const distLeft = image.wrap.distL ? emuToPixels(image.wrap.distL) : undefined;
  const distRight = image.wrap.distR
    ? emuToPixels(image.wrap.distR)
    : undefined;

  // Build position data for floating images
  let position:
    | {
        horizontal?: {
          relativeTo?: string;
          posOffset?: number;
          align?: string;
        };
        vertical?: { relativeTo?: string; posOffset?: number; align?: string };
      }
    | undefined;
  if (imagePosition) {
    position = {};
    if (imagePosition.horizontal) {
      const h: { relativeTo?: string; posOffset?: number; align?: string } = {
        relativeTo: imagePosition.horizontal.relativeTo,
      };
      if (imagePosition.horizontal.posOffset !== undefined) {
        h.posOffset = imagePosition.horizontal.posOffset;
      }
      if (imagePosition.horizontal.alignment) {
        h.align = imagePosition.horizontal.alignment;
      }
      position.horizontal = h;
    }

    if (imagePosition.vertical) {
      const v: { relativeTo?: string; posOffset?: number; align?: string } = {
        relativeTo: imagePosition.vertical.relativeTo,
      };
      if (imagePosition.vertical.posOffset !== undefined) {
        v.posOffset = imagePosition.vertical.posOffset;
      }
      if (imagePosition.vertical.alignment) {
        v.align = imagePosition.vertical.alignment;
      }
      position.vertical = v;
    }
  }

  // Convert outline to border attrs
  let borderWidth: number | undefined;
  let borderColor: string | undefined;
  let borderStyle: string | undefined;
  if (image.outline && image.outline.width) {
    // Convert EMU to pixels (1 EMU = 1/914400 inch, 1 inch = 96 px)
    borderWidth = Math.round((image.outline.width / 914_400) * 96 * 100) / 100;
    if (image.outline.color?.rgb) {
      borderColor = `#${image.outline.color.rgb}`;
    }
    // Map OOXML dash styles to CSS border styles
    const styleMap: Record<string, string> = {
      solid: "solid",
      dot: "dotted",
      dash: "dashed",
      lgDash: "dashed",
      dashDot: "dashed",
      lgDashDot: "dashed",
      lgDashDotDot: "dashed",
      sysDot: "dotted",
      sysDash: "dashed",
      sysDashDot: "dashed",
      sysDashDotDot: "dashed",
    };
    borderStyle = image.outline.style
      ? styleMap[image.outline.style] || "solid"
      : "solid";
  }

  return schema.node("image", {
    src: image.src || "",
    alt: image.alt,
    title: image.title,
    width: widthPx,
    height: heightPx,
    rId: image.rId,
    wrapType,
    displayMode,
    cssFloat,
    transform,
    // eigenpal #424 (opacity render pipeline). PR #513 added Image.opacity
    // on the model; thread it onto the PM node so the layout-bridge and
    // painter can honor it.
    opacity: image.opacity,
    distTop,
    distBottom,
    distLeft,
    distRight,
    // eigenpal #424: thread wp:srcRect crop fractions through PM attrs.
    cropTop: image.crop?.top,
    cropRight: image.crop?.right,
    cropBottom: image.crop?.bottom,
    cropLeft: image.crop?.left,
    position,
    borderWidth,
    borderColor,
    borderStyle,
    wrapText,
    hlinkHref: image.hlinkHref,
    _docxRawXml: rawXml,
  });
}

/**
 * Convert a Hyperlink to ProseMirror nodes with link mark
 *
 * @param hyperlink - The hyperlink to convert
 * @param getInheritedRunFormatting - Formatting inherited by each child run
 */
function convertHyperlink(
  hyperlink: Hyperlink,
  getInheritedRunFormatting: RunFormattingResolver,
  styleResolver?: StyleEngine | null,
  hyperlinkIndex?: number,
): PMNode[] {
  const nodes: PMNode[] = [];

  // Create link mark — internal anchors use #bookmarkName format
  const href =
    hyperlink.href || (hyperlink.anchor ? `#${hyperlink.anchor}` : "");
  const linkMark = schema.mark("hyperlink", {
    href,
    tooltip: hyperlink.tooltip,
    rId: hyperlink.rId,
    _docxHyperlinkIndex: hyperlinkIndex,
  });

  for (const child of hyperlink.children) {
    if (child.type === "run") {
      // Merge style formatting with run's inline formatting
      const runStyleFormatting = child.formatting?.styleId
        ? styleResolver?.getRunStyleOwnProperties(child.formatting.styleId)
        : undefined;
      const inheritedFormatting = getInheritedRunFormatting(child.formatting);
      const mergedFormatting = mergeTextFormatting(
        mergeTextFormatting(inheritedFormatting, runStyleFormatting),
        child.formatting,
      );
      const runMarks = textFormattingToMarks(mergedFormatting);
      // Add link mark to run marks
      const allMarks = [...runMarks, linkMark];

      // Delegate to convertRunContent so tabs/breaks/fields/symbols inside
      // a hyperlink round-trip (eigenpal #566). The earlier text-only loop
      // silently dropped TOC entries' tab between title and page number,
      // collapsing the right-aligned page number flush against the title.
      for (const content of child.content) {
        nodes.push(...convertRunContent(content, allMarks));
      }
    }
  }

  return nodes;
}

/**
 * Convert TextFormatting to ProseMirror marks
 */
function textFormattingToMarks(
  formatting: TextFormatting | undefined,
): ReturnType<typeof schema.mark>[] {
  if (!formatting) {
    return [];
  }

  const marks: ReturnType<typeof schema.mark>[] = [];
  const overrideAttrs = buildRunFormattingOverrideAttrs(formatting);

  if (overrideAttrs) {
    marks.push(schema.mark("runFormattingOverride", overrideAttrs));
  }

  // Bold
  if (formatting.bold) {
    marks.push(schema.mark("bold"));
  }

  // Italic
  if (formatting.italic) {
    marks.push(schema.mark("italic"));
  }

  // Underline
  if (formatting.underline && formatting.underline.style !== "none") {
    marks.push(
      schema.mark("underline", {
        style: formatting.underline.style,
        color: formatting.underline.color,
      }),
    );
  }

  // Strikethrough
  if (formatting.strike || formatting.doubleStrike) {
    marks.push(
      schema.mark("strike", {
        double: formatting.doubleStrike || false,
      }),
    );
  }

  // Text color
  if (formatting.color && !formatting.color.auto) {
    marks.push(
      schema.mark("textColor", {
        rgb: formatting.color.rgb,
        themeColor: formatting.color.themeColor,
        themeTint: formatting.color.themeTint,
        themeShade: formatting.color.themeShade,
      }),
    );
  }

  // Highlight
  if (formatting.highlight && formatting.highlight !== "none") {
    marks.push(
      schema.mark("highlight", {
        color: formatting.highlight,
      }),
    );
  }

  // Font size
  if (formatting.fontSize) {
    marks.push(
      schema.mark("fontSize", {
        size: formatting.fontSize,
      }),
    );
  }

  // Font family
  if (formatting.fontFamily) {
    marks.push(
      schema.mark("fontFamily", {
        ascii: formatting.fontFamily.ascii,
        hAnsi: formatting.fontFamily.hAnsi,
        eastAsia: formatting.fontFamily.eastAsia,
        cs: formatting.fontFamily.cs,
        asciiTheme: formatting.fontFamily.asciiTheme,
        hAnsiTheme: formatting.fontFamily.hAnsiTheme,
        eastAsiaTheme: formatting.fontFamily.eastAsiaTheme,
        csTheme: formatting.fontFamily.csTheme,
      }),
    );
  }

  // Superscript/Subscript
  if (formatting.vertAlign === "superscript") {
    marks.push(schema.mark("superscript"));
  } else if (formatting.vertAlign === "subscript") {
    marks.push(schema.mark("subscript"));
  }

  // All caps (w:caps)
  if (formatting.allCaps) {
    marks.push(schema.mark("allCaps"));
  }

  // Small caps (w:smallCaps)
  if (formatting.smallCaps) {
    marks.push(schema.mark("smallCaps"));
  }

  // Character spacing (spacing, position, scale, kerning)
  const spacing =
    typeof formatting.spacing === "number" ? formatting.spacing : null;
  const position =
    typeof formatting.position === "number" ? formatting.position : null;
  const scale = typeof formatting.scale === "number" ? formatting.scale : null;
  const kerning =
    typeof formatting.kerning === "number" ? formatting.kerning : null;
  if (
    spacing !== null ||
    position !== null ||
    scale !== null ||
    kerning !== null
  ) {
    marks.push(
      schema.mark("characterSpacing", {
        spacing,
        position,
        scale,
        kerning,
      }),
    );
  }

  // Hidden text (w:vanish). eigenpal #424 (gap 9).
  if (formatting.hidden === true) {
    marks.push(schema.mark("hidden"));
  }

  // Emboss (w:emboss)
  if (formatting.emboss) {
    marks.push(schema.mark("emboss"));
  }

  // Imprint/Engrave (w:imprint)
  if (formatting.imprint) {
    marks.push(schema.mark("imprint"));
  }

  // Text shadow (w:shadow)
  if (formatting.shadow) {
    marks.push(schema.mark("textShadow"));
  }

  // Emphasis mark (w:em)
  if (formatting.emphasisMark && formatting.emphasisMark !== "none") {
    marks.push(schema.mark("emphasisMark", { type: formatting.emphasisMark }));
  }

  // Text outline (w:outline)
  if (formatting.outline) {
    marks.push(schema.mark("textOutline"));
  }

  // eigenpal #424 (gap 10) — per-run RTL direction (w:rtl)
  if (formatting.rtl) {
    marks.push(schema.mark("rtl"));
  }

  // eigenpal #424 (gap 11) — text effect animation (w:effect)
  if (formatting.effect && formatting.effect !== "none") {
    marks.push(schema.mark("textEffect", { effect: formatting.effect }));
  }

  return marks;
}

// ============================================================================
// SHAPE CONVERSION
// ============================================================================

/**
 * Convert a Shape to a ProseMirror shape node (inline SVG)
 */
function convertShape(shape: Shape): PMNode {
  const shapeData: { size?: Partial<Shape["size"]> } = shape;
  const shapeSize = shapeData.size;
  const widthPx = shapeSize?.width ? emuToPixels(shapeSize.width) : 100;
  const heightPx = shapeSize?.height ? emuToPixels(shapeSize.height) : 80;
  const shapeAttrs: { shapeType?: Shape["shapeType"] } = shape;

  let fillColor: string | undefined;
  let fillType: string = "solid";
  let gradientType: string | undefined;
  let gradientAngle: number | undefined;
  let gradientStops: string | undefined;
  if (shape.fill) {
    fillType = shape.fill.type;
    if (shape.fill.color?.rgb) {
      fillColor = `#${shape.fill.color.rgb}`;
    }
    // Extract gradient data
    if (shape.fill.type === "gradient" && shape.fill.gradient) {
      const g = shape.fill.gradient;
      gradientType = g.type;
      gradientAngle = g.angle;
      // Convert stops to serializable format with CSS colors
      gradientStops = JSON.stringify(
        g.stops.map((s) => ({
          position: s.position,
          color: s.color.rgb ? `#${s.color.rgb}` : "#000000",
        })),
      );
    }
  }

  let outlineWidth: number | undefined;
  let outlineColor: string | undefined;
  let outlineStyle: string | undefined = "none";
  let outlineCap: NonNullable<Shape["outline"]>["cap"] | undefined;
  let outlineHeadEnd: NonNullable<Shape["outline"]>["headEnd"] | undefined;
  let outlineTailEnd: NonNullable<Shape["outline"]>["tailEnd"] | undefined;
  if (shape.outline) {
    if (shape.outline.width) {
      outlineWidth =
        Math.round((shape.outline.width / 914_400) * 96 * 100) / 100;
    }
    if (shape.outline.color?.rgb) {
      outlineColor = `#${shape.outline.color.rgb}`;
    }
    outlineStyle = shape.outline.style || "solid";
    outlineCap = shape.outline.cap;
    outlineHeadEnd = shape.outline.headEnd;
    outlineTailEnd = shape.outline.tailEnd;
  } else {
    outlineWidth = 0;
  }

  let transform: string | undefined;
  if (shape.transform) {
    const transforms: string[] = [];
    if (shape.transform.rotation) {
      transforms.push(`rotate(${shape.transform.rotation}deg)`);
    }
    if (shape.transform.flipH) {
      transforms.push("scaleX(-1)");
    }
    if (shape.transform.flipV) {
      transforms.push("scaleY(-1)");
    }
    if (transforms.length > 0) {
      transform = transforms.join(" ");
    }
  }

  const wrapType = shape.wrap?.type ?? "inline";
  const displayMode = wrapType === "inline" ? "inline" : "float";
  let cssFloat: "left" | "right" | "none" = "none";
  if (shape.wrap?.wrapText === "left") {
    cssFloat = "right";
  } else if (shape.wrap?.wrapText === "right") {
    cssFloat = "left";
  }

  let position: ImagePositionAttrs | undefined;
  if (shape.position) {
    position = {
      horizontal: {
        relativeTo: shape.position.horizontal.relativeTo,
        ...(shape.position.horizontal.posOffset !== undefined
          ? { posOffset: shape.position.horizontal.posOffset }
          : {}),
        ...(shape.position.horizontal.alignment
          ? { align: shape.position.horizontal.alignment }
          : {}),
      },
      vertical: {
        relativeTo: shape.position.vertical.relativeTo,
        ...(shape.position.vertical.posOffset !== undefined
          ? { posOffset: shape.position.vertical.posOffset }
          : {}),
        ...(shape.position.vertical.alignment
          ? { align: shape.position.vertical.alignment }
          : {}),
      },
    };
  }

  return schema.node("shape", {
    shapeType: shapeAttrs.shapeType ?? "rect",
    shapeId: shape.id,
    width: widthPx,
    height: heightPx,
    fillColor,
    fillType,
    gradientType,
    gradientAngle,
    gradientStops,
    outlineWidth,
    outlineColor,
    outlineStyle,
    outlineCap,
    outlineHeadEnd,
    outlineTailEnd,
    transform,
    displayMode,
    cssFloat,
    wrapType,
    wrapText: shape.wrap?.wrapText,
    distTop:
      shape.wrap?.distT !== undefined
        ? emuToPixels(shape.wrap.distT)
        : undefined,
    distBottom:
      shape.wrap?.distB !== undefined
        ? emuToPixels(shape.wrap.distB)
        : undefined,
    distLeft:
      shape.wrap?.distL !== undefined
        ? emuToPixels(shape.wrap.distL)
        : undefined,
    distRight:
      shape.wrap?.distR !== undefined
        ? emuToPixels(shape.wrap.distR)
        : undefined,
    position,
  });
}

// ============================================================================
// TEXT BOX CONVERSION
// ============================================================================

/**
 * Convert a paragraph block to PM nodes, extracting text boxes as sibling nodes.
 * Skips ghost empty paragraphs that only contained text box drawings.
 */
function convertParagraphWithTextBoxes(
  block: Paragraph,
  styleResolver: StyleEngine | null,
  textBoxGroupId: string,
): PMNode[] {
  const textBoxes = extractTextBoxesFromParagraph(block);
  const pmParagraph = convertParagraph(block, styleResolver);
  const nodes: PMNode[] = [];
  const isEmptyAfterExtraction =
    textBoxes.length > 0 && pmParagraph.content.size === 0;
  const keepWrapperParagraph =
    isEmptyAfterExtraction && hasParagraphBoundaryPayload(block, pmParagraph);
  if (!isEmptyAfterExtraction || keepWrapperParagraph) {
    nodes.push(pmParagraph);
  }
  for (const tb of textBoxes) {
    nodes.push(
      convertTextBox(tb, styleResolver, {
        placement:
          isEmptyAfterExtraction && !keepWrapperParagraph
            ? "standalone"
            : "inlineWithPrevious",
        groupId: textBoxGroupId,
      }),
    );
  }
  return nodes;
}

function hasParagraphBoundaryPayload(
  block: Paragraph,
  pmParagraph: PMNode,
): boolean {
  const bookmarks = pmParagraph.attrs["bookmarks"];
  const emptyHyperlinks = pmParagraph.attrs["_emptyHyperlinks"];
  return Boolean(
    block.sectionProperties ||
    block.propertyChanges?.length ||
    (Array.isArray(bookmarks) && bookmarks.length > 0) ||
    (Array.isArray(emptyHyperlinks) && emptyHyperlinks.length > 0),
  );
}

/**
 * Extract text boxes from paragraph runs.
 * Text boxes appear as ShapeContent where the shape has textBody,
 * or as DrawingContent that contains a text box instead of an image.
 */
function extractTextBoxesFromParagraph(paragraph: Paragraph): TextBox[] {
  const textBoxes: TextBox[] = [];
  for (const content of paragraph.content) {
    if (content.type === "run") {
      for (const rc of content.content) {
        if (rc.type === "shape") {
          const shape = rc.shape as Shape;
          if (shape.textBody) {
            // Convert shape with text body to TextBox
            const textBox: TextBox = {
              type: "textBox",
              size: shape.size,
              content: shape.textBody.content,
            };
            if (shape.id) {
              textBox.id = shape.id;
            }
            if (shape.position) {
              textBox.position = shape.position;
            }
            if (shape.wrap) {
              textBox.wrap = shape.wrap;
            }
            if (shape.fill) {
              textBox.fill = shape.fill;
            }
            if (shape.outline) {
              textBox.outline = shape.outline;
            }
            if (shape.textBody.margins) {
              textBox.margins = shape.textBody.margins;
            }
            textBoxes.push(textBox);
          }
        }
      }
    }
  }
  return textBoxes;
}

/**
 * Convert a TextBox to a ProseMirror textBox node
 */
function convertTextBox(
  textBox: TextBox,
  styleResolver: StyleEngine | null,
  options: {
    placement?: "standalone" | "inlineWithPrevious";
    groupId?: string;
  } = {},
): PMNode {
  const textBoxData: { size?: Partial<TextBox["size"]> } = textBox;
  const textBoxSize = textBoxData.size;
  const widthPx = textBoxSize?.width ? emuToPixels(textBoxSize.width) : 200;
  const heightPx = textBoxSize?.height
    ? emuToPixels(textBoxSize.height)
    : undefined;

  // Convert fill color
  let fillColor: string | undefined;
  if (textBox.fill?.color?.rgb) {
    fillColor = `#${textBox.fill.color.rgb}`;
  }

  // Convert outline
  let outlineWidth: number | undefined;
  let outlineColor: string | undefined;
  let outlineStyle: string | undefined;
  if (textBox.outline && textBox.outline.width) {
    outlineWidth =
      Math.round((textBox.outline.width / 914_400) * 96 * 100) / 100;
    if (textBox.outline.color?.rgb) {
      outlineColor = `#${textBox.outline.color.rgb}`;
    }
    outlineStyle = textBox.outline.style || "solid";
  }

  // Convert margins from EMU to pixels
  const marginTop =
    textBox.margins?.top !== undefined ? emuToPixels(textBox.margins.top) : 4;
  const marginBottom =
    textBox.margins?.bottom !== undefined
      ? emuToPixels(textBox.margins.bottom)
      : 4;
  const marginLeft =
    textBox.margins?.left !== undefined ? emuToPixels(textBox.margins.left) : 7;
  const marginRight =
    textBox.margins?.right !== undefined
      ? emuToPixels(textBox.margins.right)
      : 7;

  // Convert text box content (paragraphs) to PM nodes
  const contentNodes: PMNode[] = [];
  for (const para of textBox.content) {
    contentNodes.push(convertParagraph(para, styleResolver));
  }

  // Ensure at least one paragraph
  if (contentNodes.length === 0) {
    contentNodes.push(schema.node("paragraph", {}, []));
  }

  // Map wrap settings into the PM textBox attrs so the page renderer can
  // build floating exclusion rects for body text wrapping (eigenpal #474).
  // Mirrors the float/displayMode derivation used by `convertImage` above.
  const wrapType = textBox.wrap?.type;
  const wrapText = textBox.wrap?.wrapText;
  const hAlign = textBox.position?.horizontal.alignment;

  let cssFloat: "left" | "right" | "none" | undefined;
  if (wrapType === undefined || wrapType === "inline") {
    cssFloat = "none";
  } else if (wrapType === "topAndBottom") {
    cssFloat = "none";
  } else if (
    wrapType === "square" ||
    wrapType === "tight" ||
    wrapType === "through"
  ) {
    if (wrapText === "left") {
      cssFloat = "right";
    } else if (wrapText === "right") {
      cssFloat = "left";
    } else if (hAlign === "left") {
      cssFloat = "left";
    } else if (hAlign === "right") {
      cssFloat = "right";
    } else {
      cssFloat = "none";
    }
  } else {
    cssFloat = "none";
  }

  let displayMode: "inline" | "block" | "float";
  if (wrapType === undefined || wrapType === "inline") {
    displayMode = "inline";
  } else if (wrapType === "topAndBottom") {
    displayMode = "block";
  } else if (wrapType === "behind" || wrapType === "inFront") {
    displayMode = "float";
  } else if (cssFloat !== "none") {
    displayMode = "float";
  } else {
    displayMode = "block";
  }

  const distTop = textBox.wrap?.distT
    ? emuToPixels(textBox.wrap.distT)
    : undefined;
  const distBottom = textBox.wrap?.distB
    ? emuToPixels(textBox.wrap.distB)
    : undefined;
  const distLeft = textBox.wrap?.distL
    ? emuToPixels(textBox.wrap.distL)
    : undefined;
  const distRight = textBox.wrap?.distR
    ? emuToPixels(textBox.wrap.distR)
    : undefined;

  return schema.node(
    "textBox",
    {
      width: widthPx,
      height: heightPx,
      textBoxId: textBox.id,
      fillColor,
      outlineWidth,
      outlineColor,
      outlineStyle,
      marginTop,
      marginBottom,
      marginLeft,
      marginRight,
      displayMode,
      cssFloat,
      wrapType: wrapType ?? "inline",
      wrapText,
      distTop,
      distBottom,
      distLeft,
      distRight,
      _docxPlacement: options.placement,
      _docxGroupId: options.groupId,
    },
    contentNodes,
  );
}

/**
 * Convert HeaderFooter content (array of Paragraph/Table blocks) to a ProseMirror document.
 * Used for editing headers/footers in their own ProseMirror editor and for
 * the unified header/footer render pipeline (see
 * `core/layout-bridge/headerFooterLayout.ts`). `theme` lives in
 * `ToProseDocOptions` for future themeColor cell-shading resolution; folio's
 * `convertTable` does not yet thread it (orthogonal upstream divergence).
 */
export function headerFooterToProseDoc(
  content: BlockContent[],
  options?: ToProseDocOptions,
): PMNode {
  const nodes: PMNode[] = [];
  const styleResolver = options?.styles
    ? createStyleEngine(options.styles)
    : null;
  const theme = options?.theme ?? null;
  let textBoxGroupIndex = 0;

  const convertBlocks = (blocks: BlockContent[]): PMNode[] => {
    const out: PMNode[] = [];
    for (const block of blocks) {
      if (block.type === "paragraph") {
        out.push(
          ...convertParagraphWithTextBoxes(
            block,
            styleResolver,
            String(textBoxGroupIndex),
          ),
        );
        textBoxGroupIndex += 1;
      } else if (block.type === "table") {
        out.push(convertTable(block, styleResolver, theme));
      } else {
        out.push(convertBlockSdt(block, convertBlocks));
      }
    }
    return out;
  };

  nodes.push(...convertBlocks(content));
  // Caret affordance after a final isolating blockSdt is handled by
  // prosemirror-gapcursor at runtime; we no longer pad the converted doc
  // with a synthetic trailing paragraph because that paragraph survives
  // the reverse pass and pollutes both round-trip saves and
  // `setContentControlContent(filter, blocks)` callers that pass blocks
  // ending in a nested blockSdt.

  if (nodes.length === 0) {
    nodes.push(schema.node("paragraph", {}, []));
  }

  const pmDoc = schema.node("doc", null, nodes);
  assertValidProseMirrorDocument(
    pmDoc,
    "Header/footer conversion produced an invalid ProseMirror document",
  );
  return pmDoc;
}

export function footnoteToProseDoc(
  content: BlockContent[],
  options?: ToProseDocOptions,
): PMNode {
  return headerFooterToProseDoc(content, options);
}

/**
 * Determine where a page break appears inside a paragraph.
 *
 * Per ECMA-376 §17.3.3.1, `<w:br w:type="page"/>` is always a forced break,
 * including in a paragraph whose only content is the break itself. We previously
 * searched only top-level runs and missed breaks nested in hyperlinks, tracked
 * changes, or fields — so those paragraphs silently dropped their forced break
 * and the following content collapsed onto the previous page (common on legal
 * signature pages and exhibit covers).
 * See eigenpal docx-editor #409 (break-only page break sub-fix).
 *
 * Returns:
 *   "before" — the break appears before any visible content; the paragraph's
 *              content belongs on the NEXT page.
 *   "after"  — the break follows some visible content; the paragraph stays
 *              on the current page and the next block starts a new page.
 *   null     — no page break found.
 */
function paragraphPageBreakPosition(
  paragraph: Paragraph,
): "before" | "after" | null {
  // Mutated by visitRun during traversal. oxlint flow analysis can't see
  // closure mutations, so a plain `let` here trips no-unnecessary-condition;
  // wrap in an object to keep the flag genuinely opaque to the linter.
  const state = { seenVisibleContent: false };

  function isPageBreak(content: RunContent): boolean {
    return content.type === "break" && content.breakType === "page";
  }

  function isVisibleRunContent(content: RunContent): boolean {
    return (
      (content.type === "text" && content.text.length > 0) ||
      content.type === "tab" ||
      content.type === "drawing" ||
      content.type === "shape" ||
      content.type === "symbol" ||
      content.type === "fieldChar" ||
      content.type === "instrText" ||
      content.type === "footnoteRef" ||
      content.type === "endnoteRef" ||
      content.type === "noBreakHyphen" ||
      content.type === "softHyphen"
    );
  }

  function visitRun(run: Run): boolean {
    for (const content of run.content) {
      if (isPageBreak(content)) {
        return true;
      }
      if (isVisibleRunContent(content)) {
        state.seenVisibleContent = true;
      }
    }
    return false;
  }

  // Walk a hyperlink's children — runs (which may carry the break) plus
  // bookmark markers we ignore. Mirrors the inner shape of `Hyperlink`.
  function visitHyperlinkChildren(hyperlink: Hyperlink): boolean {
    for (const child of hyperlink.children) {
      if (child.type === "run" && visitRun(child)) {
        return true;
      }
    }
    return false;
  }

  // Walk a (Run | Hyperlink)[] list — the shared inner shape of tracked-change
  // wrappers, simple fields, and inline SDTs. We rely on visitRun to set
  // state.seenVisibleContent when (and only when) it encounters visible run
  // content; an empty wrapper must not be treated as visible — an empty
  // bookmark-only hyperlink before a page break should still classify the
  // break as "before".
  function visitRunOrHyperlinkList(children: (Run | Hyperlink)[]): boolean {
    for (const child of children) {
      if (child.type === "run" && visitRun(child)) {
        return true;
      }
      if (child.type === "hyperlink" && visitHyperlinkChildren(child)) {
        return true;
      }
    }
    return false;
  }

  function visitItem(item: Paragraph["content"][number]): boolean {
    if (item.type === "run") {
      return visitRun(item);
    }
    if (item.type === "hyperlink") {
      return visitHyperlinkChildren(item);
    }
    if (
      item.type === "insertion" ||
      item.type === "deletion" ||
      item.type === "moveFrom" ||
      item.type === "moveTo"
    ) {
      return visitRunOrHyperlinkList(item.content);
    }
    if (item.type === "simpleField") {
      return visitRunOrHyperlinkList(item.content);
    }
    if (item.type === "complexField") {
      for (const run of item.fieldResult) {
        if (visitRun(run)) {
          return true;
        }
      }
      return false;
    }
    if (item.type === "inlineSdt") {
      // SDT.content was widened in PR #508 to carry fields/math/nested SDTs;
      // recurse via visitItem so each child uses its own visibility rule.
      for (const child of item.content) {
        if (visitItem(child)) {
          return true;
        }
      }
      return false;
    }
    if (item.type === "mathEquation") {
      // OMML math is a visible inline node and cannot itself contain w:br.
      state.seenVisibleContent = true;
      return false;
    }
    return false;
  }

  for (const item of paragraph.content) {
    if (visitItem(item)) {
      return state.seenVisibleContent ? "after" : "before";
    }
  }
  return null;
}

/**
 * Create an empty ProseMirror document
 */
export function createEmptyDoc(): PMNode {
  return schema.node("doc", null, [schema.node("paragraph", {}, [])]);
}
