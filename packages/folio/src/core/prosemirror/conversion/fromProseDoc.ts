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

import type {
  ImageWrap,
  ImagePosition,
  ImageTransform,
  ShapeOutline,
  SectionProperties,
  SectionStart,
} from "../../types/content";
import type {
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
  FieldType,
  InlineSdt,
  SdtProperties,
  TrackedChangeInfo,
  MathEquation,
  ColorValue,
  CellMargins,
} from "../../types/document";
import { pixelsToEmu } from "../../utils/units";
import { applyRunFormattingOverrideMark } from "../extensions/marks/RunFormattingOverrideExtension";
import type { ShapeAttrs } from "../extensions/nodes/ShapeExtension";
import type { TextBoxAttrs } from "../extensions/nodes/TextBoxExtension";
import type {
  TextColorAttrs,
  UnderlineAttrs,
  FontFamilyAttrs,
} from "../schema/marks";
import type {
  ParagraphAttrs,
  ImageAttrs,
  TableAttrs,
  TableRowAttrs,
  TableCellAttrs,
} from "../schema/nodes";

/**
 * Convert a ProseMirror document to our Document type
 */
export function fromProseDoc(pmDoc: PMNode, baseDocument?: Document): Document {
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
 * Extract blocks (paragraphs and tables) from ProseMirror document
 */
function extractBlocks(pmDoc: PMNode): (Paragraph | Table)[] {
  const blocks: (Paragraph | Table)[] = [];
  const documentCounts = buildDocumentTrackedChangeCounts(pmDoc);

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  pmDoc.forEach((node) => {
    if (node.type.name === "paragraph") {
      blocks.push(convertPMParagraph(node, documentCounts));
    } else if (node.type.name === "table") {
      blocks.push(convertPMTable(node, documentCounts));
    } else if (node.type.name === "textBox") {
      // Convert text box back to a paragraph containing a shape with text body
      blocks.push(convertPMTextBox(node));
    } else if (node.type.name === "pageBreak") {
      // Convert page break node to a paragraph with a page break run
      blocks.push(createPageBreakParagraph());
    }
  });

  return blocks;
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

/**
 * Convert a ProseMirror paragraph node to our Paragraph type
 */
function convertPMParagraph(
  node: PMNode,
  documentCounts?: TrackedChangeCounts,
): Paragraph {
  const attrs = node.attrs as ParagraphAttrs;
  let content = extractParagraphContent(node, documentCounts);

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
    attrs.outlineLevel !== null ||
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
  if (attrs.outlineLevel !== undefined && attrs.outlineLevel !== null) {
    f.outlineLevel = attrs.outlineLevel;
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
  documentCounts?: TrackedChangeCounts,
): ParagraphContent[] {
  const content: ParagraphContent[] = [];
  const trackedChangeCounts =
    documentCounts ?? buildDocumentTrackedChangeCounts(paragraph);

  // Track current run being built
  let currentRun: Run | null = null;
  let currentMarksKey: string | null = null;
  let currentHyperlink: Hyperlink | null = null;
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

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  paragraph.forEach((node) => {
    syncCommentRanges(node);

    // Check for footnote/endnote reference mark
    const noteRefMark = node.marks.find((m) => m.type.name === "footnoteRef");
    if (noteRefMark) {
      // Finish any current content
      flushCurrentInline();
      const noteType =
        noteRefMark.attrs["noteType"] === "endnote"
          ? "endnoteRef"
          : "footnoteRef";
      const noteRef: NoteReferenceContent = {
        type: noteType,
        id: Number.parseInt(noteRefMark.attrs["id"], 10) || 0,
      };
      content.push({
        type: "run",
        content: [noteRef],
      });
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
      // Filter out the tracked change mark for text formatting extraction
      const otherMarks = node.marks.filter(
        (m) => m.type.name !== "insertion" && m.type.name !== "deletion",
      );
      const formatting = marksToTextFormatting(otherMarks);
      const run: Run = {
        type: "run",
        content:
          node.isText && node.text ? [{ type: "text", text: node.text }] : [],
        ...(Object.keys(formatting).length > 0 ? { formatting } : {}),
      };

      const info: TrackedChangeInfo = {
        id: changeMark.attrs["revisionId"] as number,
        author: (changeMark.attrs["author"] as string) || "Unknown",
      };
      const dateStr = changeMark.attrs["date"] as string;
      if (dateStr) {
        info.date = dateStr;
      }
      const revisionId = info.id;
      const hasInsertionForId =
        (trackedChangeCounts.insertionById.get(revisionId) ?? 0) > 0;
      const hasDeletionForId =
        (trackedChangeCounts.deletionById.get(revisionId) ?? 0) > 0;
      const isMovePair = hasInsertionForId && hasDeletionForId;

      if (insertionMark) {
        if (isMovePair) {
          content.push({ type: "moveTo", info, content: [run] });
        } else {
          content.push({ type: "insertion", info, content: [run] });
        }
      } else if (isMovePair) {
        content.push({ type: "moveFrom", info, content: [run] });
      } else {
        content.push({ type: "deletion", info, content: [run] });
      }
      return;
    }

    // Check for hyperlink mark
    const linkMark = node.marks.find((m) => m.type.name === "hyperlink");

    if (linkMark) {
      // Start or continue hyperlink
      const linkKey = getLinkKey(linkMark);

      const currentKey =
        currentHyperlink?.href ||
        (currentHyperlink?.anchor ? `#${currentHyperlink.anchor}` : "");
      if (currentHyperlink && currentKey === linkKey) {
        // Continue current hyperlink
        addNodeToHyperlink(currentHyperlink, node);
      } else {
        // Finish previous content
        flushCurrentInline();

        // Start new hyperlink
        currentHyperlink = createHyperlink(linkMark);
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
      content.push(createBreakRun());
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
  });

  // Don't forget the last run/hyperlink
  flushCurrentInline();
  for (const commentId of openedComments) {
    content.push({ type: "commentRangeEnd", id: commentId });
  }

  return content;
}

function getCommentMarkIds(marks: readonly Mark[]): Set<number> {
  const commentIds = new Set<number>();
  for (const mark of marks) {
    if (mark.type.name === "comment") {
      commentIds.add(mark.attrs["commentId"] as number);
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
      const revisionId = Number(insertionMark.attrs["revisionId"]);
      if (Number.isFinite(revisionId)) {
        insertionById.set(revisionId, (insertionById.get(revisionId) ?? 0) + 1);
      }
    }
    if (deletionMark) {
      const revisionId = Number(deletionMark.attrs["revisionId"]);
      if (Number.isFinite(revisionId)) {
        deletionById.set(revisionId, (deletionById.get(revisionId) ?? 0) + 1);
      }
    }
  });

  return { insertionById, deletionById };
}

/**
 * Create a unique key for a link mark
 */
function getLinkKey(mark: Mark): string {
  return mark.attrs["href"] || "";
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
  const href = linkMark.attrs["href"] as string;
  // Internal bookmark links use the anchor property in OOXML
  if (href?.startsWith("#")) {
    return {
      type: "hyperlink",
      anchor: href.slice(1),
      tooltip: linkMark.attrs["tooltip"] || undefined,
      children: [],
    };
  }
  return {
    type: "hyperlink",
    href,
    tooltip: linkMark.attrs["tooltip"] || undefined,
    rId: linkMark.attrs["rId"] || undefined,
    children: [],
  };
}

/**
 * Add a node to a hyperlink
 */
function addNodeToHyperlink(hyperlink: Hyperlink, node: PMNode): void {
  if (node.isText && node.text) {
    const nonLinkMarks = node.marks.filter((m) => m.type.name !== "hyperlink");
    const run = createRunFromText(node.text, nonLinkMarks);
    hyperlink.children.push(run);
  }
}

/**
 * Create a Run from text and marks
 */
function createRunFromText(text: string, marks: readonly Mark[]): Run {
  const formatting = marksToTextFormatting(marks);
  const textContent: TextContent = {
    type: "text",
    text,
  };

  const run: Run = { type: "run", content: [textContent] };
  if (Object.keys(formatting).length > 0) {
    run.formatting = formatting;
  }
  return run;
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
function createBreakRun(): Run {
  const breakContent: BreakContent = {
    type: "break",
    breakType: "textWrapping",
  };

  return {
    type: "run",
    content: [breakContent],
  };
}

/**
 * Create a Run containing a tab
 */
function createTabRun(): Run {
  const tabContent: TabContent = {
    type: "tab",
  };

  return {
    type: "run",
    content: [tabContent],
  };
}

/**
 * Create a SimpleField or ComplexField from a PM field node
 */
function createFieldFromNode(
  node: PMNode,
  marks?: readonly Mark[],
): SimpleField | ComplexField {
  const attrs = node.attrs as {
    fieldType: string;
    instruction: string;
    displayText: string;
    fieldKind: string;
    fldLock: boolean;
    dirty: boolean;
  };

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
      fieldType: attrs.fieldType as FieldType,
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
    fieldType: attrs.fieldType as FieldType,
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
  const attrs = node.attrs as {
    display: string;
    ommlXml: string;
    plainText: string;
  };

  const math: MathEquation = {
    type: "mathEquation",
    display: (attrs.display as "inline" | "block") || "inline",
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
  const attrs = node.attrs as Record<string, unknown>;

  const properties: SdtProperties = {
    sdtType: (attrs["sdtType"] as SdtProperties["sdtType"]) ?? "richText",
  };
  if (attrs["alias"]) {
    properties.alias = attrs["alias"] as string;
  }
  if (attrs["tag"]) {
    properties.tag = attrs["tag"] as string;
  }
  if (attrs["lock"]) {
    properties.lock = attrs["lock"] as NonNullable<SdtProperties["lock"]>;
  }
  if (attrs["placeholder"]) {
    properties.placeholder = attrs["placeholder"] as string;
  }
  if (
    attrs["showingPlaceholder"] !== undefined &&
    attrs["showingPlaceholder"] !== null
  ) {
    properties.showingPlaceholder = attrs["showingPlaceholder"] as boolean;
  }
  if (attrs["dateFormat"]) {
    properties.dateFormat = attrs["dateFormat"] as string;
  }
  if (attrs["listItems"]) {
    properties.listItems = JSON.parse(attrs["listItems"] as string);
  }
  if (attrs["checked"] !== null && attrs["checked"] !== undefined) {
    properties.checked = attrs["checked"] as boolean;
  }

  // Extract content from the sdt node's children
  const sdtContent = extractParagraphContent(node);
  const content = sdtContent.filter(
    (c): c is Run | Hyperlink => c.type === "run" || c.type === "hyperlink",
  );

  return {
    type: "inlineSdt",
    properties,
    content,
  };
}

/**
 * Create a Run containing an image
 */
function createImageRun(node: PMNode): Run {
  const attrs = node.attrs as ImageAttrs;

  // Determine wrap type from attrs (default: inline)
  const wrapType = attrs.wrapType || "inline";
  const PX_TO_EMU = 914_400 / 96;

  const wrap: ImageWrap = { type: wrapType };
  if (attrs.distTop !== undefined) {
    wrap.distT = Math.round(attrs.distTop * PX_TO_EMU);
  }
  if (attrs.distBottom !== undefined) {
    wrap.distB = Math.round(attrs.distBottom * PX_TO_EMU);
  }
  if (attrs.distLeft !== undefined) {
    wrap.distL = Math.round(attrs.distLeft * PX_TO_EMU);
  }
  if (attrs.distRight !== undefined) {
    wrap.distR = Math.round(attrs.distRight * PX_TO_EMU);
  }

  // Restore wrapText from PM attr
  if (attrs.wrapText) {
    wrap.wrapText = attrs.wrapText as NonNullable<ImageWrap["wrapText"]>;
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

  // Parse CSS transform string back to ImageTransform for round-trip
  if (attrs.transform) {
    const transformStr = attrs.transform;
    const imgTransform: ImageTransform = {};
    const rotateMatch = transformStr.match(/rotate\(([-\d.]+)deg\)/);
    if (rotateMatch) {
      // SAFETY: capture group [1] always present when regex matches
      imgTransform.rotation = Number.parseFloat(rotateMatch[1]!);
    }
    if (transformStr.includes("scaleX(-1)")) {
      imgTransform.flipH = true;
    }
    if (transformStr.includes("scaleY(-1)")) {
      imgTransform.flipV = true;
    }
    if (imgTransform.rotation || imgTransform.flipH || imgTransform.flipV) {
      image.transform = imgTransform;
    }
  }

  // Round-trip floating image position (ImagePositionAttrs uses loose strings;
  // cast to the strict OOXML union types for the Document model)
  if (attrs.position?.horizontal && attrs.position?.vertical) {
    const pos = attrs.position;
    type HRelativeTo = ImagePosition["horizontal"]["relativeTo"];
    type HAlignment = ImagePosition["horizontal"]["alignment"];
    type VRelativeTo = ImagePosition["vertical"]["relativeTo"];
    type VAlignment = ImagePosition["vertical"]["alignment"];

    const horizontal: ImagePosition["horizontal"] = {
      relativeTo: (pos.horizontal?.relativeTo || "column") as HRelativeTo,
    };
    if (pos.horizontal?.align) {
      horizontal.alignment = pos.horizontal.align as NonNullable<HAlignment>;
    }
    if (pos.horizontal?.posOffset !== undefined) {
      horizontal.posOffset = pos.horizontal.posOffset;
    }

    const vertical: ImagePosition["vertical"] = {
      relativeTo: (pos.vertical?.relativeTo || "paragraph") as VRelativeTo,
    };
    if (pos.vertical?.align) {
      vertical.alignment = pos.vertical.align as NonNullable<VAlignment>;
    }
    if (pos.vertical?.posOffset !== undefined) {
      vertical.posOffset = pos.vertical.posOffset;
    }

    image.position = { horizontal, vertical };
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
      // Convert pixels back to EMU (1 px = 914400/96 EMU)
      width: Math.round(attrs.borderWidth * (914_400 / 96)),
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

  const drawingContent: DrawingContent = {
    type: "drawing",
    image,
  };

  return {
    type: "run",
    content: [drawingContent],
  };
}

/**
 * Create a Run from a ProseMirror shape node
 */
function createShapeRun(node: PMNode): Run {
  const attrs = node.attrs as ShapeAttrs;

  const shape: Shape = {
    type: "shape",
    shapeType: (attrs.shapeType || "rect") as Shape["shapeType"],
    size: {
      width: attrs.width ? Math.round(attrs.width * (914_400 / 96)) : 0,
      height: attrs.height ? Math.round(attrs.height * (914_400 / 96)) : 0,
    },
  };
  if (attrs.shapeId) {
    shape.id = attrs.shapeId;
  }

  // Fill
  if (attrs.fillType === "gradient" && attrs.gradientStops) {
    // Round-trip gradient fill
    try {
      const parsed = JSON.parse(attrs.gradientStops) as {
        position: number;
        color: string;
      }[];
      const gradient: NonNullable<
        import("../../types/content").ShapeFill["gradient"]
      > = {
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
      type: (attrs.fillType || "solid") as "solid" | "none",
      color: { rgb: attrs.fillColor.replace("#", "") },
    };
  } else if (attrs.fillType === "none") {
    shape.fill = { type: "none" };
  }

  // Outline
  if (attrs.outlineWidth && attrs.outlineWidth > 0) {
    const cssToOoxml: Record<string, string> = {
      solid: "solid",
      dotted: "dot",
      dashed: "dash",
    };
    const shapeOutline: ShapeOutline = {
      width: Math.round(attrs.outlineWidth * (914_400 / 96)),
      style: attrs.outlineStyle
        ? (cssToOoxml[attrs.outlineStyle] as ShapeOutline["style"]) || "solid"
        : "solid",
    };
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
function marksToTextFormatting(marks: readonly Mark[]): TextFormatting {
  const formatting: TextFormatting = {};

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
        const attrs = mark.attrs as UnderlineAttrs;
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
        if (mark.attrs["double"]) {
          formatting.doubleStrike = true;
        } else {
          formatting.strike = true;
        }
        break;

      case "textColor": {
        const attrs = mark.attrs as TextColorAttrs;
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
        formatting.highlight = mark.attrs["color"];
        break;

      case "fontSize":
        formatting.fontSize = mark.attrs["size"];
        formatting.fontSizeCs = mark.attrs["size"];
        break;

      case "fontFamily": {
        const attrs = mark.attrs as FontFamilyAttrs;
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
        if (mark.attrs["spacing"] !== null) {
          formatting.spacing = mark.attrs["spacing"];
        }
        if (mark.attrs["position"] !== null) {
          formatting.position = mark.attrs["position"];
        }
        if (mark.attrs["scale"] !== null) {
          formatting.scale = mark.attrs["scale"];
        }
        if (mark.attrs["kerning"] !== null) {
          formatting.kerning = mark.attrs["kerning"];
        }
        break;
      }

      case "emboss":
        formatting.emboss = true;
        break;

      case "imprint":
        formatting.imprint = true;
        break;

      case "textShadow":
        formatting.shadow = true;
        break;

      case "emphasisMark":
        formatting.emphasisMark = mark.attrs["type"] || "dot";
        break;

      case "textOutline":
        formatting.outline = true;
        break;

      case "runFormattingOverride":
        applyRunFormattingOverrideMark(formatting, mark);
        break;

      // hyperlink is handled separately
      default:
        break;
    }
  }

  return formatting;
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
  const attrs = node.attrs as TableAttrs;
  const rows: TableRow[] = [];

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((rowNode) => {
    if (rowNode.type.name === "tableRow") {
      rows.push(convertPMTableRow(rowNode, documentCounts));
    }
  });

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
    // Width: check if changed
    const origWidthVal = orig.width?.value;
    const origWidthType = orig.width?.type;
    if (attrs.width !== origWidthVal || attrs.widthType !== origWidthType) {
      if (attrs.width !== null || attrs.widthType) {
        result.width = {
          value: attrs.width ?? 0,
          type: (attrs.widthType as "auto" | "dxa" | "pct" | "nil") || "dxa",
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
  const hasFormatting =
    attrs.styleId ||
    attrs.width !== null ||
    attrs.widthType ||
    attrs.justification ||
    attrs.floating ||
    attrs.cellMargins ||
    attrs.look;

  if (!hasFormatting) {
    return undefined;
  }

  // Convert cellMargins back to CellMargins format (twips → TableMeasurement)
  const cellMargins = attrs.cellMargins
    ? buildCellMarginsFromAttrs(attrs.cellMargins)
    : undefined;

  // Restore width — handle width=0 with type="auto" (common OOXML pattern)
  let width: TableFormatting["width"];
  if (attrs.width !== null || attrs.widthType) {
    width = {
      value: attrs.width ?? 0,
      type: (attrs.widthType as "auto" | "dxa" | "pct" | "nil") || "dxa",
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
  return f;
}

/**
 * Convert a ProseMirror table row node to our TableRow type
 */
function convertPMTableRow(
  node: PMNode,
  documentCounts?: TrackedChangeCounts,
): TableRow {
  const attrs = node.attrs as TableRowAttrs;
  const cells: TableCell[] = [];

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((cellNode) => {
    if (
      cellNode.type.name === "tableCell" ||
      cellNode.type.name === "tableHeader"
    ) {
      cells.push(convertPMTableCell(cellNode, documentCounts));
    }
  });

  const row: TableRow = { type: "tableRow", cells };
  const rowFormatting = tableRowAttrsToFormatting(attrs);
  if (rowFormatting) {
    row.formatting = rowFormatting;
  }
  return row;
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
        result.heightRule = attrs.heightRule as "auto" | "atLeast" | "exact";
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
    f.heightRule = attrs.heightRule as "auto" | "atLeast" | "exact";
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
  const attrs = node.attrs as TableCellAttrs;
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
    // Width: use !== null to handle width=0 correctly (ProseMirror can set null)
    if (attrs.width !== null) {
      result.width = {
        value: attrs.width ?? 0,
        type: (attrs.widthType as "auto" | "dxa" | "pct" | "nil") || "dxa",
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
      result.borders = attrs.borders as NonNullable<
        TableCellFormatting["borders"]
      >;
    }
    if (attrs.margins) {
      result.margins = buildCellMarginsFromAttrs(attrs.margins);
    }
    if (attrs.textDirection !== (orig.textDirection ?? undefined)) {
      if (attrs.textDirection) {
        result.textDirection = attrs.textDirection as NonNullable<
          TableCellFormatting["textDirection"]
        >;
      } else {
        delete result.textDirection;
      }
    }

    return result;
  }

  // Fallback: reconstruct formatting from individual attrs
  const hasFormatting =
    attrs.colspan > 1 ||
    attrs.rowspan > 1 ||
    attrs.width !== null ||
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
  if (attrs.width !== null) {
    f.width = {
      value: attrs.width ?? 0,
      type: (attrs.widthType as "auto" | "dxa" | "pct" | "nil") || "dxa",
    };
  }
  if (attrs.verticalAlign) {
    f.verticalAlign = attrs.verticalAlign;
  }
  if (attrs.textDirection) {
    f.textDirection = attrs.textDirection as NonNullable<
      TableCellFormatting["textDirection"]
    >;
  }
  if (attrs.backgroundColor) {
    f.shading = { fill: { rgb: attrs.backgroundColor } };
  }
  if (attrs.borders) {
    f.borders = attrs.borders as NonNullable<TableCellFormatting["borders"]>;
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
  const attrs = node.attrs as TextBoxAttrs;

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
    shapeType: "rect",
    size: {
      width: attrs.width ? Math.round(attrs.width * (914_400 / 96)) : 0,
      height: attrs.height ? Math.round(attrs.height * (914_400 / 96)) : 0,
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
        if (attrs.marginTop !== null && attrs.marginTop !== undefined) {
          m.top = Math.round(attrs.marginTop * (914_400 / 96));
        }
        if (attrs.marginBottom !== null && attrs.marginBottom !== undefined) {
          m.bottom = Math.round(attrs.marginBottom * (914_400 / 96));
        }
        if (attrs.marginLeft !== null && attrs.marginLeft !== undefined) {
          m.left = Math.round(attrs.marginLeft * (914_400 / 96));
        }
        if (attrs.marginRight !== null && attrs.marginRight !== undefined) {
          m.right = Math.round(attrs.marginRight * (914_400 / 96));
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

  // Convert outline back
  if (attrs.outlineWidth && attrs.outlineWidth > 0) {
    const cssToOoxmlOutline: Record<string, string> = {
      solid: "solid",
      dotted: "dot",
      dashed: "dash",
    };
    const tbOutline: ShapeOutline = {
      width: Math.round(attrs.outlineWidth * (914_400 / 96)),
      style: attrs.outlineStyle
        ? (cssToOoxmlOutline[attrs.outlineStyle] as ShapeOutline["style"]) ||
          "solid"
        : "solid",
    };
    if (attrs.outlineColor) {
      tbOutline.color = { rgb: attrs.outlineColor.replace("#", "") };
    }
    shape.outline = tbOutline;
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
 * Convert a ProseMirror document back to an array of Paragraph/Table blocks.
 * Used for converting edited header/footer PM content back to the document model.
 */
export function proseDocToBlocks(pmDoc: PMNode): (Paragraph | Table)[] {
  return extractBlocks(pmDoc);
}
