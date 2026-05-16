/**
 * Paragraph Extension — paragraph node with alignment, spacing, indent, style commands
 *
 * Moves:
 * - NodeSpec from nodes.ts (paragraph, ParagraphAttrs, paragraphAttrsToDOMStyle, getListClass helpers)
 * - Commands from paragraph.ts (alignment, spacing, indent, style)
 */

import { Fragment } from "prosemirror-model";
import type { Mark, Node as PMNode, NodeSpec, Schema } from "prosemirror-model";
import type { Command, EditorState, Transaction } from "prosemirror-state";

import type {
  ParagraphAlignment,
  LineSpacingRule,
  ParagraphFormatting,
  TextFormatting,
  NumberFormat,
  TabStop,
  TabStopAlignment,
  TabLeader,
} from "../../../types/document";
import { paragraphToStyle } from "../../../utils/formatToStyle";
import { collectHeadings } from "../../../utils/headingCollector";
import type { ParagraphAttrs } from "../../schema/nodes";
import { createNodeExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";

// ============================================================================
// HELPERS (from nodes.ts)
// ============================================================================

function paragraphAttrsToDOMStyle(attrs: ParagraphAttrs): string {
  const rawIndentLeft: unknown = Reflect.get(attrs, "indentLeft");
  let indentLeft =
    typeof rawIndentLeft === "number" ? rawIndentLeft : undefined;
  if (
    attrs.numPr?.numId &&
    (rawIndentLeft === null || rawIndentLeft === undefined)
  ) {
    const level = attrs.numPr.ilvl ?? 0;
    indentLeft = (level + 1) * 720;
  }

  const formatting: ParagraphFormatting = {
    ...(attrs.alignment !== undefined ? { alignment: attrs.alignment } : {}),
    ...(attrs.spaceBefore !== undefined
      ? { spaceBefore: attrs.spaceBefore }
      : {}),
    ...(attrs.spaceAfter !== undefined ? { spaceAfter: attrs.spaceAfter } : {}),
    ...(attrs.lineSpacing !== undefined
      ? { lineSpacing: attrs.lineSpacing }
      : {}),
    ...(attrs.lineSpacingRule !== undefined
      ? { lineSpacingRule: attrs.lineSpacingRule }
      : {}),
    ...(indentLeft !== undefined ? { indentLeft } : {}),
    ...(attrs.indentRight !== undefined
      ? { indentRight: attrs.indentRight }
      : {}),
    ...(attrs.indentFirstLine !== undefined
      ? { indentFirstLine: attrs.indentFirstLine }
      : {}),
    ...(attrs.hangingIndent !== undefined
      ? { hangingIndent: attrs.hangingIndent }
      : {}),
    ...(attrs.borders !== undefined ? { borders: attrs.borders } : {}),
    ...(attrs.shading !== undefined ? { shading: attrs.shading } : {}),
  };

  const style = paragraphToStyle(formatting);
  const customStyle: Record<string, string | number> = {};
  if (style.marginTop) {
    customStyle["--docx-space-before"] = style.marginTop;
  }
  if (style.marginBottom) {
    customStyle["--docx-space-after"] = style.marginBottom;
  }
  return Object.entries({ ...style, ...customStyle })
    .map(([key, value]) => {
      const cssKey = key.replace(/([A-Z])/g, "-$1").toLowerCase();
      return `${cssKey}: ${value}`;
    })
    .join("; ");
}

function numFmtToClass(numFmt: NumberFormat | undefined): string {
  // NumberFormat has 70+ values defined by OOXML; this switch
  // intentionally classifies only the four whose CSS rendering differs.
  // Every other format (decimal, Asian numerals, etc.) falls through to
  // the decimal CSS class, which matches Word's display when the
  // browser font lacks the specialised glyphs.
  switch (numFmt) {
    case "upperRoman":
      return "docx-list-upper-roman";
    case "lowerRoman":
      return "docx-list-lower-roman";
    case "upperLetter":
      return "docx-list-upper-alpha";
    case "lowerLetter":
      return "docx-list-lower-alpha";
    default:
      return "docx-list-decimal";
  }
}

function getListClass(
  numPr?: ParagraphAttrs["numPr"],
  listIsBullet?: boolean,
  listNumFmt?: NumberFormat,
): string {
  if (!numPr?.numId) {
    return "";
  }

  const level = numPr.ilvl ?? 0;

  if (listIsBullet) {
    return `docx-list-bullet docx-list-level-${level}`;
  }

  const formatClass = numFmtToClass(listNumFmt);
  return `docx-list-numbered ${formatClass} docx-list-level-${level}`;
}

// ============================================================================
// CSS-TO-TWIPS HELPERS (for paste from external apps like Google Docs)
// ============================================================================

/**
 * Parse a CSS length value to twips.
 * Supports pt, px, in, cm, mm units. Returns undefined for unparseable values.
 *
 * Conversion factors (1 inch = 1440 twips):
 * - 1pt = 20 twips (1440/72)
 * - 1px = 15 twips (1440/96)
 * - 1cm = 567 twips (1440/2.54, rounded)
 * - 1mm = 56.7 twips (1440/25.4)
 */
function cssLengthToTwips(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  const num = Number.parseFloat(trimmed);
  if (Number.isNaN(num) || num === 0) {
    return undefined;
  }

  if (trimmed.endsWith("pt")) {
    return Math.round(num * 20);
  }
  if (trimmed.endsWith("px")) {
    return Math.round(num * 15);
  }
  if (trimmed.endsWith("in")) {
    return Math.round(num * 1440);
  }
  if (trimmed.endsWith("mm")) {
    return Math.round(num * (1440 / 25.4));
  }
  if (trimmed.endsWith("cm")) {
    return Math.round(num * (1440 / 2.54));
  }
  // Bare number — treat as pixels (browser computed style default)
  if (/^[\d.]+$/.test(trimmed)) {
    return Math.round(num * 15);
  }
  return undefined;
}

/**
 * Map CSS text-align value to ParagraphAlignment.
 */
function cssTextAlignToAlignment(
  value: string,
): ParagraphAlignment | undefined {
  switch (value.trim().toLowerCase()) {
    case "left":
    case "start":
      return "left";
    case "center":
      return "center";
    case "right":
    case "end":
      return "right";
    case "justify":
      return "both";
    default:
      return undefined;
  }
}

/**
 * Parse CSS line-height to twips.
 * - Unitless multiplier (e.g. "1.5"): 240 twips * multiplier (single=240)
 * - Percentage (e.g. "150%"): 240 twips * (pct/100)
 * - Absolute length (e.g. "18pt"): converted to twips directly with 'exact' rule
 *
 * Returns { lineSpacing, lineSpacingRule } or undefined.
 */
function cssLineHeightToSpacing(
  value: string,
): { lineSpacing: number; lineSpacingRule: LineSpacingRule } | undefined {
  if (!value || value === "normal") {
    return undefined;
  }
  const trimmed = value.trim();

  // Percentage (e.g. "150%")
  if (trimmed.endsWith("%")) {
    const pct = Number.parseFloat(trimmed);
    if (Number.isNaN(pct) || pct === 0) {
      return undefined;
    }
    return {
      lineSpacing: Math.round(240 * (pct / 100)),
      lineSpacingRule: "auto",
    };
  }

  // Absolute length (has a unit like pt, px, etc.)
  if (/[a-z]/i.test(trimmed)) {
    const twips = cssLengthToTwips(trimmed);
    if (twips === undefined) {
      return undefined;
    }
    return { lineSpacing: twips, lineSpacingRule: "exact" };
  }

  // Unitless multiplier (e.g. "1.5", "2")
  const multiplier = Number.parseFloat(trimmed);
  if (Number.isNaN(multiplier) || multiplier === 0) {
    return undefined;
  }
  return { lineSpacing: Math.round(240 * multiplier), lineSpacingRule: "auto" };
}

/**
 * Extract paragraph-level attributes from a pasted HTML <p> element's inline styles.
 * Used by parseDOM to preserve formatting from external apps (Google Docs, Word Online, etc.).
 */
function extractParagraphAttrsFromStyle(
  element: HTMLElement,
): Partial<ParagraphAttrs> {
  const style = element.style;
  const attrs: Partial<ParagraphAttrs> = {};

  // Alignment — text-align CSS property
  if (style.textAlign) {
    const alignment = cssTextAlignToAlignment(style.textAlign);
    if (alignment) {
      attrs.alignment = alignment;
    }
  }

  // Left indentation — margin-left or padding-left (Google Docs uses margin-left)
  const marginLeft = style.marginLeft || style.paddingLeft;
  if (marginLeft) {
    const twips = cssLengthToTwips(marginLeft);
    if (twips !== undefined) {
      attrs.indentLeft = twips;
    }
  }

  // Right indentation — margin-right or padding-right
  const marginRight = style.marginRight || style.paddingRight;
  if (marginRight) {
    const twips = cssLengthToTwips(marginRight);
    if (twips !== undefined) {
      attrs.indentRight = twips;
    }
  }

  // First-line indent — text-indent CSS property
  if (style.textIndent) {
    const twips = cssLengthToTwips(style.textIndent);
    if (twips !== undefined) {
      if (twips < 0) {
        // Negative text-indent means hanging indent
        attrs.indentFirstLine = Math.abs(twips);
        attrs.hangingIndent = true;
      } else {
        attrs.indentFirstLine = twips;
      }
    }
  }

  // Line spacing — line-height CSS property
  if (style.lineHeight) {
    const spacing = cssLineHeightToSpacing(style.lineHeight);
    if (spacing) {
      attrs.lineSpacing = spacing.lineSpacing;
      attrs.lineSpacingRule = spacing.lineSpacingRule;
    }
  }

  // Space before/after — margin-top/margin-bottom
  if (style.marginTop) {
    const twips = cssLengthToTwips(style.marginTop);
    if (twips !== undefined) {
      attrs.spaceBefore = twips;
    }
  }
  if (style.marginBottom) {
    const twips = cssLengthToTwips(style.marginBottom);
    if (twips !== undefined) {
      attrs.spaceAfter = twips;
    }
  }

  return attrs;
}

// ============================================================================
// PARAGRAPH NODE SPEC
// ============================================================================

const paragraphNodeSpec: NodeSpec = {
  content: "inline*",
  group: "block",
  attrs: {
    paraId: { default: null },
    textId: { default: null },
    alignment: { default: null },
    spaceBefore: { default: null },
    spaceAfter: { default: null },
    lineSpacing: { default: null },
    lineSpacingRule: { default: null },
    spacingExplicit: { default: null },
    indentLeft: { default: null },
    indentRight: { default: null },
    indentFirstLine: { default: null },
    hangingIndent: { default: false },
    numPr: { default: null },
    listNumFmt: { default: null },
    listIsBullet: { default: null },
    listIsLegal: { default: null },
    listMarker: { default: null },
    listMarkerHidden: { default: null },
    listMarkerFontFamily: { default: null },
    listMarkerFontSize: { default: null },
    listLevelNumFmts: { default: null },
    listAbstractNumId: { default: null },
    listStartOverride: { default: null },
    styleId: { default: null },
    borders: { default: null },
    shading: { default: null },
    tabs: { default: null },
    pageBreakBefore: { default: null },
    renderedPageBreakBefore: { default: null },
    keepNext: { default: null },
    keepLines: { default: null },
    contextualSpacing: { default: null },
    runInWithNext: { default: null },
    defaultTextFormatting: { default: null },
    sectionBreakType: { default: null },
    bidi: { default: null },
    outlineLevel: { default: null },
    bookmarks: { default: null },
    _originalFormatting: { default: null },
    _sectionProperties: { default: null },
    _propertyChanges: { default: null },
  },
  parseDOM: [
    {
      tag: "p",
      getAttrs(dom): ParagraphAttrs | false {
        if (!(dom instanceof HTMLElement)) {
          return false;
        }
        const element = dom;

        // Start with data-attribute values (from our own editor's copy/paste)
        const paraId = element.dataset["paraId"];
        const alignment = element.dataset["alignment"] as
          | ParagraphAlignment
          | undefined;
        const styleId = element.dataset["styleId"];
        const sectionBreakType = element.dataset["sectionBreak"] as
          | NonNullable<ParagraphAttrs["sectionBreakType"]>
          | undefined;
        const attrs: ParagraphAttrs = {
          ...(paraId ? { paraId } : {}),
          ...(alignment ? { alignment } : {}),
          ...(styleId ? { styleId } : {}),
          ...(sectionBreakType ? { sectionBreakType } : {}),
        };

        // Extract paragraph formatting from inline CSS styles
        // (covers paste from Google Docs, Word Online, and other external apps)
        const styleAttrs = extractParagraphAttrsFromStyle(element);

        // Merge: data-attributes take precedence over CSS-extracted values
        const mergedAlignment = attrs.alignment || styleAttrs.alignment;
        return {
          ...styleAttrs,
          ...attrs,
          // For alignment, prefer data-attribute if present, otherwise use CSS
          ...(mergedAlignment !== undefined
            ? { alignment: mergedAlignment }
            : {}),
        };
      },
    },
    // Heading tags (h1-h6) — pasted from Google Docs, Word Online, etc.
    // Map to paragraphs with appropriate styleId and formatting extracted from CSS.
    ...(["h1", "h2", "h3", "h4", "h5", "h6"] as const).map((tag) => ({
      tag,
      getAttrs(dom: HTMLElement): ParagraphAttrs {
        const level = Number.parseInt(tag.charAt(1), 10);
        const styleAttrs = extractParagraphAttrsFromStyle(dom);

        return {
          ...styleAttrs,
          styleId: `Heading${level}`,
          outlineLevel: level - 1,
        };
      },
    })),
  ],
  toDOM(node) {
    const attrs = node.attrs as ParagraphAttrs;
    const style = paragraphAttrsToDOMStyle(attrs);
    const listClass = getListClass(
      attrs.numPr,
      attrs.listIsBullet,
      attrs.listNumFmt,
    );

    const domAttrs: Record<string, string> = {};

    if (style) {
      domAttrs["style"] = style;
    }

    if (listClass) {
      domAttrs["class"] = listClass;
    }

    if (attrs.paraId) {
      domAttrs["data-para-id"] = attrs.paraId;
    }

    if (attrs.alignment) {
      domAttrs["data-alignment"] = attrs.alignment;
    }

    if (attrs.styleId) {
      domAttrs["data-style-id"] = attrs.styleId;
    }

    if (attrs.listMarker) {
      domAttrs["data-list-marker"] = attrs.listMarker;
    }

    if (attrs.bidi) {
      domAttrs["dir"] = "rtl";
    }

    if (attrs.sectionBreakType) {
      domAttrs["data-section-break"] = attrs.sectionBreakType;
      domAttrs["class"] =
        `${domAttrs["class"] ? `${domAttrs["class"]} ` : ""}docx-section-break`;
    }

    return ["p", domAttrs, 0];
  },
};

// ============================================================================
// PARAGRAPH COMMAND HELPERS
// ============================================================================

function setParagraphAttr(attr: string, value: unknown): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;

    if (!dispatch) {
      return true;
    }

    let tr = state.tr;
    const seen = new Set<number>();

    state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (node.type.name === "paragraph" && !seen.has(pos)) {
        seen.add(pos);
        tr = tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          [attr]: value,
        });
      }
    });

    dispatch(tr.scrollIntoView());
    return true;
  };
}

function setParagraphAttrsCmd(attrs: Record<string, unknown>): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;

    if (!dispatch) {
      return true;
    }

    let tr = state.tr;
    const seen = new Set<number>();

    state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (node.type.name === "paragraph" && !seen.has(pos)) {
        seen.add(pos);
        tr = tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          ...attrs,
        });
      }
    });

    dispatch(tr.scrollIntoView());
    return true;
  };
}

// ============================================================================
// RESOLVED STYLE ATTRS (for applyStyle)
// ============================================================================

export type ResolvedStyleAttrs = {
  paragraphFormatting?: ParagraphFormatting;
  runFormatting?: TextFormatting;
};

// ============================================================================
// COMMAND FACTORIES
// ============================================================================

function makeSetAlignment(alignment: ParagraphAlignment): Command {
  return (state, dispatch) =>
    setParagraphAttr("alignment", alignment)(state, dispatch);
}

function makeSetLineSpacing(
  value: number,
  rule: LineSpacingRule = "auto",
): Command {
  return (state, dispatch) =>
    setParagraphAttrsCmd({
      lineSpacing: value,
      lineSpacingRule: rule,
    })(state, dispatch);
}

function makeIncreaseIndent(amount: number = 720): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;

    if (!dispatch) {
      return true;
    }

    let tr = state.tr;
    const seen = new Set<number>();

    state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (node.type.name === "paragraph" && !seen.has(pos)) {
        seen.add(pos);
        const currentIndent = node.attrs["indentLeft"] || 0;
        tr = tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          indentLeft: currentIndent + amount,
        });
      }
    });

    dispatch(tr.scrollIntoView());
    return true;
  };
}

function makeDecreaseIndent(amount: number = 720): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;

    if (!dispatch) {
      return true;
    }

    let tr = state.tr;
    const seen = new Set<number>();

    state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (node.type.name === "paragraph" && !seen.has(pos)) {
        seen.add(pos);
        const currentIndent = node.attrs["indentLeft"] || 0;
        const newIndent = Math.max(0, currentIndent - amount);
        tr = tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          indentLeft: newIndent > 0 ? newIndent : null,
        });
      }
    });

    dispatch(tr.scrollIntoView());
    return true;
  };
}

function makeApplyStyle(schema: Schema) {
  return (styleId: string, resolvedAttrs?: ResolvedStyleAttrs): Command =>
    (state, dispatch) => {
      const { $from, $to } = state.selection;

      if (!dispatch) {
        return true;
      }

      let tr = state.tr;
      const seen = new Set<number>();

      // Build marks from run formatting if provided
      const styleMarks: Mark[] = [];
      if (resolvedAttrs?.runFormatting) {
        const rpr = resolvedAttrs.runFormatting;

        if (rpr.bold && schema.marks["bold"]) {
          styleMarks.push(schema.marks["bold"].create());
        }
        if (rpr.italic && schema.marks["italic"]) {
          styleMarks.push(schema.marks["italic"].create());
        }
        if (rpr.fontSize && schema.marks["fontSize"]) {
          styleMarks.push(
            schema.marks["fontSize"].create({ size: rpr.fontSize }),
          );
        }
        if (rpr.fontFamily && schema.marks["fontFamily"]) {
          styleMarks.push(
            schema.marks["fontFamily"].create({
              ascii: rpr.fontFamily.ascii,
              hAnsi: rpr.fontFamily.hAnsi,
              asciiTheme: rpr.fontFamily.asciiTheme,
            }),
          );
        }
        if (rpr.color && !rpr.color.auto && schema.marks["textColor"]) {
          styleMarks.push(
            schema.marks["textColor"].create({
              rgb: rpr.color.rgb,
              themeColor: rpr.color.themeColor,
              themeTint: rpr.color.themeTint,
              themeShade: rpr.color.themeShade,
            }),
          );
        }
        if (
          rpr.underline &&
          rpr.underline.style !== "none" &&
          schema.marks["underline"]
        ) {
          styleMarks.push(
            schema.marks["underline"].create({
              style: rpr.underline.style,
              color: rpr.underline.color,
            }),
          );
        }
        if ((rpr.strike || rpr.doubleStrike) && schema.marks["strike"]) {
          styleMarks.push(
            schema.marks["strike"].create({
              double: rpr.doubleStrike || false,
            }),
          );
        }
      }

      // Mark types that are controlled by style definitions
      const styleControlledMarks = [
        schema.marks["bold"],
        schema.marks["italic"],
        schema.marks["fontSize"],
        schema.marks["fontFamily"],
        schema.marks["textColor"],
        schema.marks["underline"],
        schema.marks["strike"],
      ].filter(Boolean);

      state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
        if (node.type.name === "paragraph" && !seen.has(pos)) {
          seen.add(pos);

          const newAttrs: Record<string, unknown> = {
            ...node.attrs,
            styleId,
          };

          if (resolvedAttrs) {
            // When applying a style, explicitly reset all style-controlled
            // paragraph attrs to the new style's values (or null to clear).
            // This prevents old style properties (e.g. heading line spacing)
            // from persisting when switching to a different style.
            const ppr = resolvedAttrs.paragraphFormatting;
            newAttrs["alignment"] = ppr?.alignment ?? null;
            newAttrs["spaceBefore"] = ppr?.spaceBefore ?? null;
            newAttrs["spaceAfter"] = ppr?.spaceAfter ?? null;
            newAttrs["lineSpacing"] = ppr?.lineSpacing ?? null;
            newAttrs["lineSpacingRule"] = ppr?.lineSpacingRule ?? null;
            newAttrs["indentLeft"] = ppr?.indentLeft ?? null;
            newAttrs["indentRight"] = ppr?.indentRight ?? null;
            newAttrs["indentFirstLine"] = ppr?.indentFirstLine ?? null;
            newAttrs["hangingIndent"] = ppr?.hangingIndent ?? null;
            newAttrs["contextualSpacing"] = ppr?.contextualSpacing ?? null;
            newAttrs["keepNext"] = ppr?.keepNext ?? null;
            newAttrs["keepLines"] = ppr?.keepLines ?? null;
            newAttrs["pageBreakBefore"] = ppr?.pageBreakBefore ?? null;
            newAttrs["outlineLevel"] = ppr?.outlineLevel ?? null;
          }

          tr = tr.setNodeMarkup(pos, undefined, newAttrs);

          // Only modify marks when we have resolved style attrs
          // (fallback path without resolvedAttrs just sets styleId)
          if (resolvedAttrs) {
            const paragraphStart = pos + 1;
            const paragraphEnd = pos + node.nodeSize - 1;

            if (paragraphEnd > paragraphStart) {
              // Clear old style-controlled marks first
              for (const markType of styleControlledMarks) {
                tr = tr.removeMark(paragraphStart, paragraphEnd, markType);
              }
              // Then add the new style's marks
              for (const mark of styleMarks) {
                tr = tr.addMark(paragraphStart, paragraphEnd, mark);
              }
            }
          }
        }
      });

      if (styleMarks.length > 0) {
        tr = tr.setStoredMarks(styleMarks);
      }

      dispatch(tr.scrollIntoView());
      return true;
    };
}

// ============================================================================
// QUERY HELPERS (exported for toolbar)
// ============================================================================

export function getParagraphAlignment(
  state: EditorState,
): ParagraphAlignment | null {
  const { $from } = state.selection;
  const paragraph = $from.parent;

  if (paragraph.type.name !== "paragraph") {
    return null;
  }
  return paragraph.attrs["alignment"] || null;
}

export function getParagraphTabs(state: EditorState): TabStop[] | null {
  const { $from } = state.selection;
  const paragraph = $from.parent;

  if (paragraph.type.name !== "paragraph") {
    return null;
  }
  return paragraph.attrs["tabs"] || null;
}

export function getStyleId(state: EditorState): string | null {
  const { $from } = state.selection;
  const paragraph = $from.parent;

  if (paragraph.type.name !== "paragraph") {
    return null;
  }
  return paragraph.attrs["styleId"] || null;
}

export function getParagraphBidi(state: EditorState): boolean {
  const { $from } = state.selection;
  const paragraph = $from.parent;

  if (paragraph.type.name !== "paragraph") {
    return false;
  }
  return !!paragraph.attrs["bidi"];
}

// ============================================================================
// EXTENSION
// ============================================================================

export const ParagraphExtension = createNodeExtension({
  name: "paragraph",
  schemaNodeName: "paragraph",
  nodeSpec: paragraphNodeSpec,
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const applyStyleFn = makeApplyStyle(ctx.schema);

    return {
      commands: {
        setAlignment: (alignment: ParagraphAlignment) =>
          makeSetAlignment(alignment),
        alignLeft: () => makeSetAlignment("left"),
        alignCenter: () => makeSetAlignment("center"),
        alignRight: () => makeSetAlignment("right"),
        alignJustify: () => makeSetAlignment("both"),
        setLineSpacing: (value: number, rule?: LineSpacingRule) =>
          makeSetLineSpacing(value, rule),
        singleSpacing: () => makeSetLineSpacing(240),
        oneAndHalfSpacing: () => makeSetLineSpacing(360),
        doubleSpacing: () => makeSetLineSpacing(480),
        setSpaceBefore: (twips: number) =>
          setParagraphAttr("spaceBefore", twips),
        setSpaceAfter: (twips: number) => setParagraphAttr("spaceAfter", twips),
        increaseIndent: (amount?: number) => makeIncreaseIndent(amount),
        decreaseIndent: (amount?: number) => makeDecreaseIndent(amount),
        setIndentLeft: (twips: number) =>
          setParagraphAttr("indentLeft", twips > 0 ? twips : null),
        setIndentRight: (twips: number) =>
          setParagraphAttr("indentRight", twips > 0 ? twips : null),
        setIndentFirstLine: (twips: number, hanging?: boolean) =>
          setParagraphAttrsCmd({
            indentFirstLine: twips > 0 ? twips : null,
            hangingIndent: hanging ?? false,
          }),
        applyStyle: (styleId: string, resolvedAttrs?: ResolvedStyleAttrs) =>
          applyStyleFn(styleId, resolvedAttrs),
        clearStyle: () => setParagraphAttr("styleId", null),
        insertSectionBreak: (
          breakType: "nextPage" | "continuous" | "oddPage" | "evenPage",
        ) => setParagraphAttr("sectionBreakType", breakType),
        removeSectionBreak: () => setParagraphAttr("sectionBreakType", null),
        generateTOC:
          () => (state: EditorState, dispatch?: (tr: Transaction) => void) => {
            const headings = collectHeadings(state.doc);
            if (headings.length === 0) {
              return false;
            }
            if (!dispatch) {
              return true;
            }

            const { schema: s } = state;
            const tr = state.tr;

            // Generate unique bookmark names for each heading and set them on heading paragraphs
            const bookmarkEntries: {
              name: string;
              level: number;
              text: string;
            }[] = [];
            for (const h of headings) {
              const bookmarkName = `_Toc${Math.floor(100_000_000 + Math.random() * 900_000_000)}`;
              bookmarkEntries.push({
                name: bookmarkName,
                level: h.level,
                text: h.text,
              });

              // Map position through prior transaction steps, then resolve against current tr.doc
              const mappedPos = tr.mapping.map(h.pmPos);
              const $pos = tr.doc.resolve(mappedPos);
              const paragraphNode = $pos.nodeAfter;
              if (paragraphNode && paragraphNode.type.name === "paragraph") {
                // Filter out any existing _Toc bookmarks to avoid duplicates on regeneration
                const existingBookmarks =
                  (paragraphNode.attrs["bookmarks"] as
                    | {
                        id: number;
                        name: string;
                      }[]
                    | undefined) ?? [];
                const filteredBookmarks = existingBookmarks.filter(
                  (b) => !b.name.startsWith("_Toc"),
                );
                const newBookmarks = [
                  ...filteredBookmarks,
                  {
                    id: Math.floor(Math.random() * 2_147_483_647),
                    name: bookmarkName,
                  },
                ];
                tr.setNodeMarkup(mappedPos, undefined, {
                  ...paragraphNode.attrs,
                  bookmarks: newBookmarks,
                });
              }
            }

            // Build TOC paragraphs
            const tocNodes: PMNode[] = [];

            // TOC title
            tocNodes.push(
              s.node(
                "paragraph",
                { styleId: "TOCHeading", alignment: "center" },
                [
                  s.text(
                    "Table of Contents",
                    s.marks["bold"] ? [s.marks["bold"].create()] : [],
                  ),
                ],
              ),
            );

            // TOC entries with hyperlinks
            for (const entry of bookmarkEntries) {
              const indent = entry.level * 720; // 0.5 inch per level in twips
              const tocStyleId = `TOC${entry.level + 1}`; // TOC1, TOC2, etc.
              if (!s.marks["hyperlink"]) {
                continue;
              }
              const linkMark = s.marks["hyperlink"].create({
                href: `#${entry.name}`,
              });

              tocNodes.push(
                s.node(
                  "paragraph",
                  {
                    styleId: tocStyleId,
                    indentLeft: indent > 0 ? indent : null,
                  },
                  [s.text(entry.text, [linkMark])],
                ),
              );
            }

            // Insert TOC at cursor position — use a Fragment for correct ordering
            const insertPos = tr.mapping.map(state.selection.from);
            tr.insert(insertPos, Fragment.from(tocNodes));
            dispatch(tr.scrollIntoView());
            return true;
          },
        toggleBidi:
          () => (state: EditorState, dispatch?: (tr: Transaction) => void) => {
            const { $from } = state.selection;
            const paragraph = $from.parent;
            if (paragraph.type.name !== "paragraph") {
              return false;
            }
            const currentBidi = paragraph.attrs["bidi"] || false;
            return setParagraphAttr("bidi", currentBidi ? null : true)(
              state,
              dispatch,
            );
          },
        setRtl: () => setParagraphAttr("bidi", true),
        setLtr: () => setParagraphAttr("bidi", null),
        setTabs: (tabs: TabStop[]) =>
          setParagraphAttr("tabs", tabs.length > 0 ? tabs : null),
        addTabStop:
          (
            position: number,
            alignment: TabStopAlignment = "left",
            leader: TabLeader = "none",
          ) =>
          (state: EditorState, dispatch?: (tr: Transaction) => void) => {
            const { $from } = state.selection;
            const paragraph = $from.parent;
            if (paragraph.type.name !== "paragraph") {
              return false;
            }
            const currentTabs: TabStop[] = paragraph.attrs["tabs"] || [];
            const filtered = currentTabs.filter(
              (t: TabStop) => t.position !== position,
            );
            const newTabs = [
              ...filtered,
              { position, alignment, leader },
            ].toSorted((a: TabStop, b: TabStop) => a.position - b.position);
            return setParagraphAttr("tabs", newTabs)(state, dispatch);
          },
        removeTabStop:
          (position: number) =>
          (state: EditorState, dispatch?: (tr: Transaction) => void) => {
            const { $from } = state.selection;
            const paragraph = $from.parent;
            if (paragraph.type.name !== "paragraph") {
              return false;
            }
            const currentTabs: TabStop[] = paragraph.attrs["tabs"] || [];
            const newTabs = currentTabs.filter(
              (t: TabStop) => t.position !== position,
            );
            return setParagraphAttr(
              "tabs",
              newTabs.length > 0 ? newTabs : null,
            )(state, dispatch);
          },
      },
    };
  },
});
