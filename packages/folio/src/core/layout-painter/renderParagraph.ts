/**
 * Paragraph Fragment Renderer
 *
 * Renders paragraph fragments with lines and text runs to DOM.
 * Handles text formatting, alignment, and positioning.
 */

import { getListMarkerInlineWidth } from "../layout-bridge/measuring/listMarkerWidth";
import type {
  ParagraphBlock,
  ParagraphMeasure,
  ParagraphFragment,
  ParagraphBorders,
  BorderStyle,
  MeasuredLine,
  Run,
  TextRun,
  TabRun,
  ImageRun,
  LineBreakRun,
  FieldRun,
  TabStop,
} from "../layout-engine/types";
import { calculateTabWidth } from "../prosemirror/utils/tabCalculator";
import type {
  TabContext,
  TabStop as TabCalcStop,
} from "../prosemirror/utils/tabCalculator";
import { getAuthorColorIdx, AUTHOR_COLORS } from "../utils/authorColors";
import { resolveFontFamily } from "../utils/fontResolver";
import { DOCX_BOLD_FONT_WEIGHT } from "../utils/fontWeights";
import { getAutomaticTextColorForBackground } from "./documentColors";
import { isFloatingImageRun } from "./renderUtils";
import type { RenderContext } from "./renderUtils";

/**
 * CSS class names for paragraph rendering
 */
export const PARAGRAPH_CLASS_NAMES = {
  fragment: "layout-paragraph",
  line: "layout-line",
  run: "layout-run",
  text: "layout-run-text",
  tab: "layout-run-tab",
  image: "layout-run-image",
  lineBreak: "layout-run-linebreak",
};

// Text wrapping around floating images is implemented via measurement-time
// per-line leftOffset/rightOffset. renderPage.ts re-measures paragraphs with
// FloatingImageZone[] when floating images are present on the page.

/**
 * Options for rendering a paragraph
 */
export type RenderParagraphOptions = {
  /** Document to create elements in */
  document?: Document;
  /** Fragment's Y position relative to content area (for per-line margin calculation) */
  fragmentContentY?: number;
  /** Borders from the previous adjacent paragraph (for border grouping) */
  prevBorders?: ParagraphBorders;
  /** Borders from the next adjacent paragraph (for border grouping) */
  nextBorders?: ParagraphBorders;
  /** Inline image runs already rendered for this paragraph block */
  renderedInlineImageKeys?: Set<string>;
};

/**
 * Check if run is a text run
 */
function isTextRun(run: Run): run is TextRun {
  return run.kind === "text";
}

/**
 * Check if run is a tab run
 */
function isTabRun(run: Run): run is TabRun {
  return run.kind === "tab";
}

/**
 * Check if run is an image run
 */
function isImageRun(run: Run): run is ImageRun {
  return run.kind === "image";
}

/**
 * Check if run is a line break run
 */
function isLineBreakRun(run: Run): run is LineBreakRun {
  return run.kind === "lineBreak";
}

/**
 * Check if run is a field run
 */
function isFieldRun(run: Run): run is FieldRun {
  return run.kind === "field";
}

const AUTOMATIC_TEXT_COLOR_VALUES = new Set(["auto", "windowtext"]);
const DEFAULT_BLACK_TEXT_COLOR_VALUES = new Set(["000000", "000"]);

function normalizeTextColorValue(color: string): string {
  return color.trim().toLowerCase().replace(/^#/u, "");
}

function isAutomaticTextColor(color: string): boolean {
  return AUTOMATIC_TEXT_COLOR_VALUES.has(normalizeTextColorValue(color));
}

function isDefaultBlackTextColor(color: string): boolean {
  return DEFAULT_BLACK_TEXT_COLOR_VALUES.has(normalizeTextColorValue(color));
}

function shouldRenderTextColor(
  color: string,
  highlight: string | undefined,
  textColorSource: TextRun["textColorSource"],
): boolean {
  if (isAutomaticTextColor(color)) {
    return false;
  }

  if (highlight) {
    return (
      textColorSource !== "paragraphDefault" || !isDefaultBlackTextColor(color)
    );
  }

  return !isDefaultBlackTextColor(color);
}

function getRenderableTextColor(run: TextRun | TabRun): string | undefined {
  const textColor = run.color;
  if (!textColor) {
    return undefined;
  }

  if (!shouldRenderTextColor(textColor, run.highlight, run.textColorSource)) {
    return undefined;
  }

  return textColor.trim();
}

function getHyperlinkTextColor(run: TextRun, inheritedColor: string): string {
  const textColor = run.color?.trim();
  if (
    textColor &&
    !isAutomaticTextColor(textColor) &&
    run.textColorSource === "direct"
  ) {
    return textColor;
  }

  return getRenderableTextColor(run) || inheritedColor || "#0563c1";
}

/**
 * Apply text run styles to an element
 */
function applyRunStyles(element: HTMLElement, run: TextRun | TabRun): void {
  // Font properties
  if (run.fontFamily) {
    // Use the font resolver for category-appropriate fallback stacks,
    // matching the same stacks used in measureContainer.ts
    element.style.fontFamily = resolveFontFamily(run.fontFamily).cssFallback;
  }
  if (run.fontSize) {
    // fontSize is in points - convert to pixels to match Canvas measurement
    // (1pt = 96/72 px at standard web DPI)
    // Using px ensures consistent rendering with Canvas-based measurements
    const fontSizePx = (run.fontSize * 96) / 72;
    element.style.fontSize = `${fontSizePx}px`;
  }
  if (run.bold) {
    element.style.fontWeight = DOCX_BOLD_FONT_WEIGHT;
  }
  if (run.italic) {
    element.style.fontStyle = "italic";
  }

  // Color — skip black/auto so the CSS variable --doc-canvas-text can adapt to dark mode
  let hasExplicitTextColor = false;
  const textColor = getRenderableTextColor(run);
  if (textColor) {
    element.style.color = textColor;
    hasExplicitTextColor = true;
  }

  // Letter spacing
  if (run.letterSpacing) {
    element.style.letterSpacing = `${run.letterSpacing}px`;
  }

  if (run.allCaps) {
    element.style.textTransform = "uppercase";
  }
  if (run.smallCaps) {
    element.style.fontVariant = "small-caps";
  }
  if (run.positionPx) {
    element.style.verticalAlign = `${run.positionPx}px`;
  }
  if (run.horizontalScale && run.horizontalScale !== 100) {
    element.style.display = "inline-block";
    element.style.transform = `scaleX(${run.horizontalScale / 100})`;
    element.style.transformOrigin = "left center";
  }
  if (run.kerningMinPt && run.kerningMinPt > 0) {
    const fontSizePt = run.fontSize ?? 11;
    if (fontSizePt >= run.kerningMinPt) {
      element.style.fontKerning = "normal";
    }
  }
  if (run.emboss) {
    element.style.textShadow =
      "1px 1px 1px rgba(255,255,255,0.5), -1px -1px 1px rgba(0,0,0,0.3)";
  }
  if (run.imprint) {
    element.style.textShadow =
      "-1px -1px 1px rgba(255,255,255,0.5), 1px 1px 1px rgba(0,0,0,0.3)";
  }
  if (run.textShadow && !run.emboss && !run.imprint) {
    element.style.textShadow = "1px 1px 2px rgba(0,0,0,0.3)";
  }
  if (run.textOutline) {
    element.style.webkitTextStroke = "1px currentColor";
    (
      element.style as CSSStyleDeclaration & {
        webkitTextFillColor?: string;
      }
    ).webkitTextFillColor = "transparent";
  }
  if (run.emphasisMark) {
    let variant = "filled dot";
    if (run.emphasisMark === "comma") {
      variant = "filled sesame";
    } else if (run.emphasisMark === "circle") {
      variant = "filled circle";
    }
    const position =
      run.emphasisMark === "underDot" ? "under right" : "over right";
    element.style.textEmphasis = variant;
    element.style.textEmphasisPosition = position;
    (
      element.style as CSSStyleDeclaration & { webkitTextEmphasis?: string }
    ).webkitTextEmphasis = variant;
    (
      element.style as CSSStyleDeclaration & {
        webkitTextEmphasisPosition?: string;
      }
    ).webkitTextEmphasisPosition = position;
  }

  // Highlight (background color)
  if (run.highlight) {
    element.style.backgroundColor = run.highlight;
    const hasTrackedChangeColor = run.isInsertion || run.isDeletion;
    const hasCommentHighlight =
      run.commentIds !== undefined && run.commentIds.length > 0;
    const automaticTextColor =
      hasExplicitTextColor || hasTrackedChangeColor || hasCommentHighlight
        ? undefined
        : getAutomaticTextColorForBackground(run.highlight);
    if (automaticTextColor) {
      element.style.color = automaticTextColor;
    }
  }

  // Text decorations
  const decorations: string[] = [];

  if (run.underline) {
    decorations.push("underline");
    if (typeof run.underline === "object") {
      if (run.underline.style) {
        element.style.textDecorationStyle = run.underline.style;
      }
      if (run.underline.color) {
        element.style.textDecorationColor = run.underline.color;
      }
    }
  }

  if (run.strike) {
    decorations.push("line-through");
  }

  // Comment highlight
  if (run.commentIds && run.commentIds.length > 0) {
    element.style.backgroundColor = "rgba(255, 212, 0, 0.08)";
    element.style.borderBottom = "1px solid rgba(180, 130, 0, 0.24)";
    element.dataset["commentId"] = String(run.commentIds[0]);
  }

  // Tracked insertion styling — Word-style colored underline per author
  if (run.isInsertion) {
    const authorIdx = getAuthorColorIdx(run.changeAuthor ?? "");
    const authorColor = AUTHOR_COLORS[authorIdx]!; // SAFETY: getAuthorColorIdx returns index within AUTHOR_COLORS bounds
    element.style.color = authorColor;
    if (!decorations.includes("underline")) {
      decorations.push("underline");
    }
    element.style.textDecorationColor = authorColor;
    element.classList.add("docx-insertion");
    element.dataset["tcAuthorIdx"] = String(authorIdx);
    // Author tooltip
    const insertionParts = [
      run.changeAuthor,
      run.changeDate ? new Date(run.changeDate).toLocaleDateString() : "",
    ].filter(Boolean);
    if (insertionParts.length > 0) {
      element.title = `Inserted: ${insertionParts.join(", ")}`;
    }
    if (run.changeAuthor) {
      element.dataset["changeAuthor"] = run.changeAuthor;
    }
    if (run.changeDate) {
      element.dataset["changeDate"] = run.changeDate;
    }
    if (run.changeRevisionId !== undefined) {
      element.dataset["revisionId"] = String(run.changeRevisionId);
    }
  }

  // Tracked deletion styling — Word-style colored strikethrough per author
  if (run.isDeletion) {
    const authorIdx = getAuthorColorIdx(run.changeAuthor ?? "");
    const authorColor = AUTHOR_COLORS[authorIdx]!; // SAFETY: getAuthorColorIdx returns index within AUTHOR_COLORS bounds
    element.style.color = authorColor;
    if (!decorations.includes("line-through")) {
      decorations.push("line-through");
    }
    element.style.textDecorationColor = authorColor;
    element.classList.add("docx-deletion");
    element.dataset["tcAuthorIdx"] = String(authorIdx);
    // Author tooltip
    const deletionParts = [
      run.changeAuthor,
      run.changeDate ? new Date(run.changeDate).toLocaleDateString() : "",
    ].filter(Boolean);
    if (deletionParts.length > 0) {
      element.title = `Deleted: ${deletionParts.join(", ")}`;
    }
    if (run.changeAuthor) {
      element.dataset["changeAuthor"] = run.changeAuthor;
    }
    if (run.changeDate) {
      element.dataset["changeDate"] = run.changeDate;
    }
    if (run.changeRevisionId !== undefined) {
      element.dataset["revisionId"] = String(run.changeRevisionId);
    }
  }

  if (decorations.length > 0) {
    element.style.textDecorationLine = decorations.join(" ");
  }

  // Superscript/subscript
  if (run.superscript) {
    element.style.verticalAlign = "super";
    element.style.fontSize = "0.75em";
  }
  if (run.subscript) {
    element.style.verticalAlign = "sub";
    element.style.fontSize = "0.75em";
  }
}

function reserveScaledAdvance(
  element: HTMLElement,
  unscaledWidth: number,
  horizontalScale: number | undefined,
): void {
  if (horizontalScale === undefined || horizontalScale === 100) {
    return;
  }
  element.style.width = `${unscaledWidth * (horizontalScale / 100)}px`;
}

/**
 * Apply PM position data attributes
 */
function applyPmPositions(
  element: HTMLElement,
  pmStart?: number,
  pmEnd?: number,
): void {
  if (pmStart !== undefined) {
    element.dataset["pmStart"] = String(pmStart);
  }
  if (pmEnd !== undefined) {
    element.dataset["pmEnd"] = String(pmEnd);
  }
}

/**
 * Render a text run
 */
function renderTextRun(run: TextRun, doc: Document): HTMLElement {
  const span = doc.createElement("span");
  span.className = `${PARAGRAPH_CLASS_NAMES.run} ${PARAGRAPH_CLASS_NAMES.text}`;

  applyRunStyles(span, run);
  applyPmPositions(span, run.pmStart, run.pmEnd);

  // Handle hyperlinks
  if (run.hyperlink) {
    const anchor = doc.createElement("a");
    anchor.href = run.hyperlink.href;
    // Internal bookmark links (starting with #) should scroll within the document
    // External links should open in a new tab
    if (!run.hyperlink.href.startsWith("#")) {
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    }
    if (run.hyperlink.tooltip) {
      anchor.title = run.hyperlink.tooltip;
    }
    anchor.textContent = run.text;
    // TOC entries opt out of the Hyperlink character style — Word renders
    // them in the paragraph's own colour, no underline. The bridge sets
    // `noDefaultStyle: true` and strips resolved colour/underline; here we
    // skip the link fallback so the anchor inherits from the wrapping span.
    if (!run.hyperlink.noDefaultStyle) {
      // Default Word hyperlink color is blue (#0563c1)
      const hyperlinkColor = getHyperlinkTextColor(run, span.style.color);
      anchor.style.color = hyperlinkColor;
      anchor.style.textDecoration = "underline";
      // Override span color to match anchor (prevents color mismatch in selection)
      span.style.color = hyperlinkColor;
    }
    span.append(anchor);
  } else {
    // Set text content
    span.textContent = run.text;
  }

  return span;
}

/**
 * Number of leader characters to fill the tab's inner span. The inner span
 * uses `overflow: hidden` so excess characters are clipped invisibly; we just
 * need enough to span the widest realistic tab stop at the thinnest leader
 * (a dot at small font sizes). 1000 covers wide-landscape pages with ~2px dots.
 */
const LEADER_FILL_COUNT = 1000;

/**
 * Render a tab run with calculated width.
 *
 * Leader characters (dot/hyphen/underscore for TOC entries) render in an
 * absolute-positioned inner span over a baseline-aligned zero-width-space.
 * The earlier SVG background-image approach sat at the line's bottom edge,
 * misaligned with the surrounding text baseline and broken under flex layout
 * (where the outer's height collapses to the inner content). The
 * outer-with-ZWSP + inner-absolute pattern keeps the tab's baseline anchored
 * to the surrounding text and lets the right-tab flex anchor compute a stable
 * height for the line.
 */
function renderTabRun(
  run: TabRun,
  doc: Document,
  width: number,
  leader?: string,
): HTMLElement {
  const span = doc.createElement("span");
  span.className = `${PARAGRAPH_CLASS_NAMES.run} ${PARAGRAPH_CLASS_NAMES.tab}`;

  span.style.display = "inline-block";
  span.style.width = `${width}px`;

  applyPmPositions(span, run.pmStart, run.pmEnd);

  const leaderChar = leader && leader !== "none" ? getLeaderChar(leader) : null;

  if (leaderChar) {
    // Outer span holds a zero-width space so its baseline aligns with the
    // surrounding text. Inner absolutely-positioned span carries the dots
    // and clips horizontally; keeping `overflow: hidden` off the outer
    // avoids the inline-block baseline-at-margin-edge problem.
    span.style.position = "relative";
    span.textContent = "\u200B"; // zero-width space

    const inner = doc.createElement("span");
    inner.style.position = "absolute";
    inner.style.left = "0";
    inner.style.right = "0";
    inner.style.top = "0";
    inner.style.bottom = "0";
    inner.style.overflow = "hidden";
    inner.style.whiteSpace = "nowrap";
    inner.textContent = leaderChar.repeat(LEADER_FILL_COUNT);
    span.append(inner);
  } else {
    // No leader: a single nbsp carries the line-height for layout.
    span.textContent = "\u00A0";
  }

  return span;
}

/**
 * Get leader character for tab
 */
function getLeaderChar(leader: string): string | null {
  switch (leader) {
    case "dot":
      return ".";
    case "hyphen":
      return "-";
    case "underscore":
      return "_";
    case "middleDot":
      return "·";
    case "heavy":
      return "_";
    default:
      return null;
  }
}

/**
 * Render an inline image run (flows with text)
 */
function renderInlineImageRun(run: ImageRun, doc: Document): HTMLElement {
  const img = doc.createElement("img");
  img.className = `${PARAGRAPH_CLASS_NAMES.run} ${PARAGRAPH_CLASS_NAMES.image}`;

  img.src = run.src;
  img.width = run.width;
  img.height = run.height;
  img.style.width = `${run.width}px`;
  img.style.height = `${run.height}px`;
  if (run.alt) {
    img.alt = run.alt;
  }
  if (run.transform) {
    img.style.transform = run.transform;
  }

  // Inline images should flow with text
  img.style.display = "inline";
  // Anchor at line top regardless of CSS reset (Tailwind preflight sets
  // `img { vertical-align: middle }`, which clips against paragraph
  // borders when the image overflows the baseline) — eigenpal #409.
  img.style.verticalAlign = "top";

  // wp:inline distT/distB: the measurer folds these into maxImageHeightPx;
  // applying them as margins here keeps the margin-box footprint consistent
  // with the line height the measurer reserved.
  if (run.distTop) {
    img.style.marginTop = `${run.distTop}px`;
  }
  if (run.distBottom) {
    img.style.marginBottom = `${run.distBottom}px`;
  }

  applyPmPositions(img, run.pmStart, run.pmEnd);

  return img;
}

/**
 * Render a block image (on its own line, like topAndBottom)
 */
function renderBlockImage(run: ImageRun, doc: Document): HTMLElement {
  const container = doc.createElement("div");
  container.className = "layout-block-image";
  container.style.display = "block";
  container.style.textAlign = "center";
  container.style.marginTop = `${run.distTop ?? 6}px`;
  container.style.marginBottom = `${run.distBottom ?? 6}px`;

  const img = doc.createElement("img");
  img.src = run.src;
  img.width = run.width;
  img.height = run.height;
  // Global CSS reset (Tailwind preflight) sets img { display: block },
  // which makes text-align: center on the container ineffective.
  // Use margin: auto on the img itself to center it.
  img.style.marginLeft = "auto";
  img.style.marginRight = "auto";
  if (run.alt) {
    img.alt = run.alt;
  }
  if (run.transform) {
    img.style.transform = run.transform;
  }

  applyPmPositions(container, run.pmStart, run.pmEnd);
  container.append(img);

  return container;
}

/**
 * Render an image run based on its display mode
 * Note: Floating images (square/tight/through) are handled separately at paragraph level,
 * not through this function. If they reach here, render as block.
 */
function renderImageRun(run: ImageRun, doc: Document): HTMLElement {
  // Floating images should be handled at paragraph level, not here
  // If they reach here (e.g., inside table cells), render as block
  if (
    isFloatingImageRun(run) ||
    run.displayMode === "block" ||
    run.wrapType === "topAndBottom"
  ) {
    return renderBlockImage(run, doc);
  }
  // Default: inline
  return renderInlineImageRun(run, doc);
}

/**
 * Render a line break run
 */
function renderLineBreakRun(run: LineBreakRun, doc: Document): HTMLElement {
  const br = doc.createElement("br");
  br.className = `${PARAGRAPH_CLASS_NAMES.run} ${PARAGRAPH_CLASS_NAMES.lineBreak}`;

  applyPmPositions(br, run.pmStart, run.pmEnd);

  return br;
}

/**
 * Render a field run (PAGE, NUMPAGES, etc.)
 * Substitutes the field with actual values from context.
 */
function renderFieldRun(
  run: FieldRun,
  doc: Document,
  context: RenderContext,
): HTMLElement {
  let text = run.fallback ?? "";

  switch (run.fieldType) {
    case "PAGE":
      text = String(context.pageNumber);
      break;
    case "NUMPAGES":
      text = String(context.totalPages);
      break;
    case "DATE":
      text = new Date().toLocaleDateString();
      break;
    case "TIME":
      text = new Date().toLocaleTimeString();
      break;
    case "OTHER":
      // Any field we don't recognise — render the cached fallback Word
      // last computed (already assigned to `text` above).
      break;
  }

  // Spread the whole FieldRun so every RunFormatting field carries through —
  // Word renders the field result with the result run's full w:rPr. Explicit
  // enumeration silently drops future RunFormatting fields and dropped the
  // footer page-number's font/colour (eigenpal #575). The extra `fieldType`,
  // `fallback`, and `kind: "field"` keys are inert on TextRun, but we still
  // overwrite `kind` and `text` to the resolved values.
  const resolvedRun: TextRun = {
    ...run,
    kind: "text",
    text,
  };

  return renderTextRun(resolvedRun, doc);
}

/**
 * Render a single run (for non-tab runs)
 */
function renderRun(
  run: Run,
  doc: Document,
  context?: RenderContext,
): HTMLElement {
  if (isTextRun(run)) {
    return renderTextRun(run, doc);
  }
  if (isTabRun(run)) {
    // Tab runs should be handled by renderLine with proper width calculation
    // This is a fallback for cases where tab context isn't available
    return renderTabRun(run, doc, 48); // Default 0.5 inch tab
  }
  if (isImageRun(run)) {
    return renderImageRun(run, doc);
  }
  if (isLineBreakRun(run)) {
    return renderLineBreakRun(run, doc);
  }
  if (isFieldRun(run) && context) {
    return renderFieldRun(run, doc, context);
  }

  // Fallback for unknown run types
  const span = doc.createElement("span");
  span.className = PARAGRAPH_CLASS_NAMES.run;
  return span;
}

/**
 * Slice runs for a specific line
 *
 * @param block - The paragraph block
 * @param line - The line measurement
 * @returns Array of runs for this line
 */
export function sliceRunsForLine(
  block: ParagraphBlock,
  line: MeasuredLine,
): Run[] {
  const result: Run[] = [];
  const runs = block.runs;

  for (let runIndex = line.fromRun; runIndex <= line.toRun; runIndex++) {
    const run = runs[runIndex];
    if (!run) {
      continue;
    }

    if (isTextRun(run)) {
      // Get the character range for this run
      const startChar = runIndex === line.fromRun ? line.fromChar : 0;
      const endChar = runIndex === line.toRun ? line.toChar : run.text.length;

      // Slice the text if needed
      if (startChar > 0 || endChar < run.text.length) {
        const slicedText = run.text.slice(startChar, endChar);
        result.push({
          ...run,
          text: slicedText,
          ...(run.pmStart !== undefined
            ? { pmStart: run.pmStart + startChar, pmEnd: run.pmStart + endChar }
            : {}),
        });
      } else {
        result.push(run);
      }
    } else {
      // Non-text runs are included as-is
      result.push(run);
    }
  }

  return result;
}

/**
 * Options for rendering a line with justify support
 */
type RenderLineOptions = {
  /** Available width for the line (content area width minus indentation) */
  availableWidth: number;
  /** Whether this is the last line of the paragraph */
  isLastLine: boolean;
  /** Whether this is the first line of the paragraph */
  isFirstLine: boolean;
  /** Whether the paragraph ends with a line break */
  paragraphEndsWithLineBreak: boolean;
  /** Tab stops from paragraph attributes */
  tabStops?: TabStop[];
  /** Render context for field substitution */
  context?: RenderContext;
  /** Left indent in pixels */
  leftIndentPx?: number;
  /** First line indent in pixels (positive) or hanging indent (negative) */
  firstLineIndentPx?: number;
  /** Line-specific floating image margins (calculated per-line based on Y overlap) */
  floatingMargins?: { leftMargin: number; rightMargin: number };
  /** Track inline image runs already rendered in this paragraph fragment to prevent duplicates */
  renderedInlineImageKeys?: Set<string>;
  /**
   * Rightmost x where inline content may render, in content-area coords. Used
   * by the right-tab anchor (TOC pattern); passed in directly rather than
   * recomposed from `leftIndentPx + availableWidth` because availableWidth
   * excludes the hung-out region for some inputs and would drift.
   */
  lineRightEdgePx?: number;
};

/**
 * Sub-pixel tolerance when comparing canvas-measured widths against the DOM's
 * actual right edge. Accumulated rounding from canvas measureText vs. browser
 * layout can leave a right-anchored tab one pixel short, so the flex anchor
 * must trigger within this slack.
 */
const RIGHT_EDGE_EPSILON_PX = 0.5;

/**
 * Build a TextMeasureStyle from a TextRun or FieldRun's relevant fields.
 */
function runMeasureStyle(run: TextRun | FieldRun): TextMeasureStyle {
  return {
    ...(run.bold !== undefined ? { bold: run.bold } : {}),
    ...(run.italic !== undefined ? { italic: run.italic } : {}),
    ...(run.letterSpacing !== undefined
      ? { letterSpacing: run.letterSpacing }
      : {}),
    ...(run.smallCaps !== undefined ? { smallCaps: run.smallCaps } : {}),
  };
}

/**
 * Sum the pixel widths of runs that follow a tab on the same line, up to the
 * next tab or line break. Measures per-run so the right-tab anchor reserves
 * the exact space the trailing content will take when it uses a different
 * font/size from the default (e.g. TOC page numbers). Floating images
 * contribute 0 inline width — they render at the page level.
 */
function measureFollowingContentWidth(
  runs: Run[],
  tabRunIndex: number,
  measureText: (
    text: string,
    fontSize?: number,
    fontFamily?: string,
    style?: TextMeasureStyle,
  ) => number,
  context?: RenderContext,
): number {
  let width = 0;
  for (let i = tabRunIndex + 1; i < runs.length; i++) {
    // SAFETY: i < runs.length
    const run = runs[i]!;
    if (isTabRun(run) || isLineBreakRun(run)) {
      break;
    }
    // Apply horizontalScale to match what the renderer's main loop does to
    // currentX (`measuredWidth * (run.horizontalScale ?? 100) / 100`). Without
    // this, expanded/compressed text after a tab over/under-estimates the
    // trailing width and the right-edge check fires (or doesn't) at the wrong
    // threshold, causing alignment drift on scaled TOC entries.
    const scale = (run as { horizontalScale?: number }).horizontalScale ?? 100;
    if (isTextRun(run)) {
      const text = run.allCaps ? run.text.toLocaleUpperCase() : run.text;
      width +=
        measureText(
          text,
          run.fontSize ?? 11,
          run.fontFamily ?? "Calibri",
          runMeasureStyle(run),
        ) *
        (scale / 100);
    } else if (isFieldRun(run)) {
      let fieldText = run.fallback ?? "";
      if (run.fieldType === "PAGE" && context) {
        fieldText = String(context.pageNumber);
      } else if (run.fieldType === "NUMPAGES" && context) {
        fieldText = String(context.totalPages);
      }
      width +=
        measureText(
          run.allCaps ? fieldText.toLocaleUpperCase() : fieldText,
          run.fontSize ?? 11,
          run.fontFamily ?? "Calibri",
          runMeasureStyle(run),
        ) *
        (scale / 100);
    } else if (isImageRun(run) && !isFloatingImageRun(run)) {
      // Inline images aren't horizontally scaled by w:w on the surrounding
      // text run; their own width attribute is authoritative.
      width += run.width || 0;
    }
  }
  return width;
}

/**
 * Build a stable key for an inline image run.
 * PM positions are preferred because they uniquely identify the source node.
 */
function getInlineImageRunKey(run: ImageRun): string {
  return [
    run.pmStart ?? "no-start",
    run.pmEnd ?? "no-end",
    run.src,
    run.width,
    run.height,
    run.displayMode ?? "inline",
    run.wrapType ?? "none",
  ].join("|");
}

/**
 * Convert layout engine TabStop to tab calculator TabStop format
 */
function convertTabStopToCalc(stop: TabStop): TabCalcStop {
  return {
    val: stop.val,
    pos: stop.pos,
    ...(stop.leader !== undefined
      ? { leader: stop.leader as NonNullable<TabCalcStop["leader"]> }
      : {}),
  };
}

/**
 * Get the text content immediately following a tab run in the runs array
 * Used for center/end/decimal tab alignment calculations
 */
function getTextAfterTab(
  runs: Run[],
  tabRunIndex: number,
  context?: RenderContext,
): string {
  let text = "";
  for (let i = tabRunIndex + 1; i < runs.length; i++) {
    const run = runs[i]!; // SAFETY: i < runs.length
    if (isTextRun(run)) {
      text += run.text;
    } else if (isFieldRun(run)) {
      // Resolve field values for TOC page numbers
      if (run.fieldType === "PAGE" && context) {
        text += String(context.pageNumber);
      } else if (run.fieldType === "NUMPAGES" && context) {
        text += String(context.totalPages);
      } else {
        text += run.fallback ?? "";
      }
    } else if (isTabRun(run) || isLineBreakRun(run)) {
      // Stop at next tab or line break
      break;
    }
  }
  return text;
}

/**
 * Create a text measurement function using a temporary canvas
 * Uses the same font fallback chain as measureContainer.ts
 */
type TextMeasureStyle = {
  bold?: boolean;
  italic?: boolean;
  letterSpacing?: number;
  smallCaps?: boolean;
};

function applyLetterSpacingToMeasuredWidth(
  width: number,
  text: string,
  letterSpacing: number | undefined,
): number {
  if (!letterSpacing || text.length <= 1) {
    return width;
  }

  return width + letterSpacing * (text.length - 1);
}

function createTextMeasurer(
  doc: Document,
): (
  text: string,
  fontSize?: number,
  fontFamily?: string,
  style?: TextMeasureStyle,
) => number {
  const canvas = doc.createElement("canvas");
  const ctx = canvas.getContext("2d");

  return (
    text: string,
    fontSize = 11,
    fontFamily = "Calibri",
    style: TextMeasureStyle = {},
  ) => {
    if (!ctx) {
      return applyLetterSpacingToMeasuredWidth(
        text.length * 7,
        text,
        style.letterSpacing,
      );
    } // Fallback estimate
    // Use font resolver for category-appropriate fallback stacks,
    // matching measureContainer.ts
    const cssFallback = resolveFontFamily(fontFamily).cssFallback;
    // Convert pt to px for canvas (1pt = 96/72 px)
    const fontSizePx = (fontSize * 96) / 72;
    const fontParts: string[] = [];
    if (style.italic) {
      fontParts.push("italic");
    }
    if (style.smallCaps) {
      fontParts.push("small-caps");
    }
    if (style.bold) {
      fontParts.push(DOCX_BOLD_FONT_WEIGHT);
    }
    fontParts.push(`${fontSizePx}px`, cssFallback);
    ctx.font = fontParts.join(" ");
    return applyLetterSpacingToMeasuredWidth(
      ctx.measureText(text).width,
      text,
      style.letterSpacing,
    );
  };
}

/**
 * Render a single line
 *
 * @param block - The paragraph block
 * @param line - The line measurement
 * @param alignment - Text alignment
 * @param doc - Document to create elements in
 * @param options - Additional options for justify calculation
 * @returns The line DOM element
 */
export function renderLine(
  block: ParagraphBlock,
  line: MeasuredLine,
  alignment: "left" | "center" | "right" | "justify" | undefined,
  doc: Document,
  options?: RenderLineOptions,
): HTMLElement {
  const lineEl = doc.createElement("div");
  lineEl.className = PARAGRAPH_CLASS_NAMES.line;

  // Apply line height
  lineEl.style.height = `${line.lineHeight}px`;
  lineEl.style.lineHeight = `${line.lineHeight}px`;

  // Get runs for this line
  const runsForLine = sliceRunsForLine(block, line);
  if (runsForLine.length === 1 && isImageRun(runsForLine[0]!)) {
    lineEl.style.display = "flex";
    lineEl.style.alignItems = "center";
  } else if (runsForLine.some((r) => isImageRun(r) && !isFloatingImageRun(r))) {
    // Inline image flowing alongside text/tabs (logo + label header). Word
    // seats an inline image as a tall glyph on the text baseline, so
    // baseline-align the row — the image bottom then lands on the text
    // baseline. The line height was measured to match (imageH + text
    // descent). Stays paired with the measurer's `fromRun !== toRun` branch.
    //
    // Gated to NON-floating images: floating images render in a page-level
    // (or cell-level) layer and `continue` in the main loop, so a line that
    // only contains floating images shouldn't be flex-promoted — that would
    // change alignment / indent / line-height semantics for normal text
    // wrapping around a floating object.
    lineEl.style.display = "flex";
    lineEl.style.alignItems = "baseline";
    // Flex defaults to flex-start regardless of the parent's text-align, so
    // a centred / right-aligned paragraph would left-align after the flex
    // switch. Mirror the paragraph alignment onto justify-content so
    // image+text header lines stay centred / right-aligned like Word.
    if (alignment === "center") {
      lineEl.style.justifyContent = "center";
    } else if (alignment === "right") {
      lineEl.style.justifyContent = "flex-end";
    }
    // Flex blockifies the run spans, so they'd otherwise inherit the line's
    // image-inflated line-height as their own box height — fattening each
    // text run to the full band and breaking baseline alignment. Reset to
    // the font's natural line box; the line div keeps its explicit `height`.
    lineEl.style.lineHeight = "normal";
  }

  // Handle empty lines
  if (runsForLine.length === 0) {
    const emptySpan = doc.createElement("span");
    emptySpan.className = `${PARAGRAPH_CLASS_NAMES.run} layout-empty-run`;
    const contentStart =
      block.pmStart === undefined ? undefined : block.pmStart + 1;
    applyPmPositions(emptySpan, contentStart, block.pmEnd ?? contentStart);
    emptySpan.innerHTML = "&nbsp;";
    lineEl.append(emptySpan);
    return lineEl;
  }

  // Calculate justify spacing if needed
  const isJustify = alignment === "justify";

  if (isJustify && options) {
    // Justify all lines except the last line (unless it ends with line break)
    const shouldJustify =
      !options.isLastLine || options.paragraphEndsWithLineBreak;

    if (shouldJustify) {
      // Use CSS text-align: justify with text-align-last: justify
      // This forces the browser to justify even single-line blocks
      lineEl.style.textAlign = "justify";
      lineEl.style.textAlignLast = "justify";
      // Set explicit width so browser knows how wide to justify to
      lineEl.style.width = `${options.availableWidth}px`;
    }
  }

  // Use white-space: pre to prevent internal wrapping AND preserve consecutive spaces.
  // All line breaking is done during measurement. 'pre' ensures multiple spaces
  // are rendered visually (unlike 'nowrap' which collapses them).
  lineEl.style.whiteSpace = "pre";

  // Check if any run in this line has a highlight. If so, we need overflow:hidden
  // to prevent the padding-extended background from bleeding into adjacent lines.
  const hasHighlight = runsForLine.some((r) => isTextRun(r) && r.highlight);
  lineEl.style.overflow = hasHighlight ? "hidden" : "visible";

  // Per-line floating margins (leftOffset/rightOffset) are now applied by
  // renderParagraphFragment via MeasuredLine offsets from re-measurement.

  // Build tab context if we have tab runs - also create for text measurement
  const hasTabRuns = runsForLine.some(isTabRun);
  let tabContext: TabContext | undefined;

  // Always create text measurer for accurate X position tracking
  const measureText = createTextMeasurer(doc);

  if (hasTabRuns) {
    // Convert tab stops from layout engine format to tab calculator format
    const explicitStops = options?.tabStops?.map(convertTabStopToCalc);

    // Convert left indent from pixels to twips for tab calculation
    // The leftIndent serves two purposes in the tab calculator:
    // 1. For hanging indent paragraphs, it adds an implicit tab stop at the left margin
    // 2. Default tab stops are generated at regular intervals from the left margin
    const leftIndentTwips = options?.leftIndentPx
      ? Math.round(options.leftIndentPx * 15)
      : 0;

    tabContext = {
      ...(explicitStops !== undefined ? { explicitStops } : {}),
      leftIndent: leftIndentTwips,
    };
  }

  // Track current X position for tab calculations
  // Tab stops are measured from the content area left edge (page text area)
  // We need to track where on that coordinate system our text is
  let currentX: number;
  const leftIndentPx = options?.leftIndentPx ?? 0;

  if (options?.isFirstLine) {
    // First line position depends on first-line indent or hanging indent:
    // - With hanging indent (firstLineIndentPx < 0): starts at leftIndent + firstLineIndent
    // - With first-line indent (firstLineIndentPx > 0): starts at leftIndent + firstLineIndent
    // - No indent: starts at leftIndent
    const firstLineIndentPx = options.firstLineIndentPx ?? 0;
    currentX = leftIndentPx + firstLineIndentPx;
  } else {
    // Non-first lines start at the left indent position
    currentX = leftIndentPx;
  }

  // Render each run
  for (let i = 0; i < runsForLine.length; i++) {
    const run = runsForLine[i]!; // SAFETY: i < runsForLine.length

    if (isTabRun(run) && tabContext) {
      // Get text following this tab for alignment calculations
      const followingText = getTextAfterTab(runsForLine, i, options?.context);

      // Calculate tab width based on current position
      const tabResult = calculateTabWidth(
        currentX,
        tabContext,
        followingText,
        measureText,
      );

      // Right-tab anchor (TOC pattern): when an end-aligned tab's stop is at
      // (or past) the line's right edge AND no later tab follows on this
      // line, promote the line to flex and let flex layout pin the trailing
      // content flush right. This sidesteps canvas-vs-DOM measurement drift
      // that otherwise leaves the page number a pixel short of the margin.
      const lineRightEdgeX = options?.lineRightEdgePx;
      const followingWidthForCheck =
        lineRightEdgeX !== undefined
          ? measureFollowingContentWidth(
              runsForLine,
              i,
              measureText,
              options?.context,
            )
          : 0;
      let hasFollowingTab = false;
      for (let j = i + 1; j < runsForLine.length; j++) {
        // SAFETY: j < runsForLine.length
        const next = runsForLine[j]!;
        if (isLineBreakRun(next)) {
          break;
        }
        if (isTabRun(next)) {
          hasFollowingTab = true;
          break;
        }
      }
      const useRightAnchor =
        lineRightEdgeX !== undefined &&
        tabResult.alignment === "end" &&
        !hasFollowingTab &&
        currentX + tabResult.width + followingWidthForCheck >=
          lineRightEdgeX - RIGHT_EDGE_EPSILON_PX;

      if (useRightAnchor) {
        // Promote to flex row. text-indent applies per flex item (not to the
        // group), so a hanging-indent paragraph would pull every text item
        // left including the page number — we re-apply the first-line
        // indent as margin-left on the first flex child after the tab is
        // appended (see below).
        lineEl.style.display = "flex";
        lineEl.style.alignItems = "baseline";
        // `pre` matches the non-flex path on the same renderLine: it both
        // preserves consecutive spaces (TOC titles can carry XML-preserved
        // multi-spaces) and disallows mid-line wrap, which is the property
        // the flex anchor needs. `nowrap` would prevent wrap but collapse
        // consecutive spaces, silently changing rendered content.
        lineEl.style.whiteSpace = "pre";
        lineEl.style.textIndent = "0";
        // Centered / right-aligned paragraphs need explicit justify-content:
        // flex defaults to flex-start regardless of the parent's text-align,
        // so without this the page number is still flush right (the anchor's
        // whole point) but the title — and any other trailing content — would
        // ignore the paragraph's alignment.
        if (alignment === "center") {
          lineEl.style.justifyContent = "center";
        } else if (alignment === "right") {
          lineEl.style.justifyContent = "flex-end";
        }
        lineEl.dataset["flexLine"] = "true";

        // The tab flex-grows to fill the remaining line space; the leader
        // inside is absolutely positioned and clips to the tab's box.
        const tabEl = renderTabRun(run, doc, 0, tabResult.leader);
        tabEl.style.flex = "1 1 0";
        tabEl.style.minWidth = "0";
        tabEl.style.width = "auto";
        lineEl.append(tabEl);

        // Re-apply the first-line indent as margin-left on the first flex
        // child now that we know what it is (the tab itself when no prior
        // runs rendered, or the earlier text/image otherwise). Done AFTER
        // append so we don't no-op on tab-first lines (firstElementChild
        // would be null pre-append). Both negative (hanging) and positive
        // (firstLine) offsets are honoured.
        if (
          options?.isFirstLine &&
          options.firstLineIndentPx !== undefined &&
          options.firstLineIndentPx !== 0 &&
          lineEl.firstElementChild instanceof HTMLElement
        ) {
          lineEl.firstElementChild.style.marginLeft = `${options.firstLineIndentPx}px`;
        }

        // Render the remaining runs into the line at their natural width.
        // Flex layout puts them flush against the line's right edge.
        for (let j = i + 1; j < runsForLine.length; j++) {
          // SAFETY: j < runsForLine.length
          const next = runsForLine[j]!;
          if (isTabRun(next) || isLineBreakRun(next)) {
            break;
          }
          if (isTextRun(next)) {
            lineEl.append(renderTextRun(next, doc));
          } else if (isFieldRun(next) && options?.context) {
            lineEl.append(renderFieldRun(next, doc, options.context));
          } else if (isImageRun(next)) {
            // Floating images render in dedicated layers — skip here so we
            // don't double-render. Inline images render via getInlineImageRunKey
            // bookkeeping so the orchestrator doesn't repaint them.
            if (isFloatingImageRun(next)) {
              continue;
            }
            const imageKey = getInlineImageRunKey(next);
            if (!options?.renderedInlineImageKeys?.has(imageKey)) {
              options?.renderedInlineImageKeys?.add(imageKey);
              lineEl.append(renderImageRun(next, doc));
            }
          } else {
            lineEl.append(renderRun(next, doc, options?.context));
          }
        }

        break;
      }

      // Fallback path: not a right-anchored tab. Clamp the tab width so it
      // doesn't overshoot the line's right edge when the stop sits just past
      // the content area (Word TOC styles author stops a hair beyond the
      // margin); without this, the painted tab spills into the right margin.
      let tabWidth = tabResult.width;
      if (
        lineRightEdgeX !== undefined &&
        currentX + tabWidth + followingWidthForCheck > lineRightEdgeX
      ) {
        tabWidth = Math.max(
          1,
          lineRightEdgeX - currentX - followingWidthForCheck,
        );
      }

      const tabEl = renderTabRun(run, doc, tabWidth, tabResult.leader);
      lineEl.append(tabEl);

      // Update X position
      currentX += tabWidth;
    } else if (isTextRun(run)) {
      const runEl = renderTextRun(run, doc);

      // For highlighted runs, extend background to fill the full line height.
      // Inline elements' background only covers the content area (font ascent+descent),
      // which differs by font size. Vertical padding on inline elements extends the
      // background without affecting line box calculations.
      if (run.highlight) {
        const fontSizePx = run.fontSize ? (run.fontSize * 96) / 72 : 14.67;
        const contentHeight = fontSizePx * 1.2; // approximate content area
        const gap = Math.max(0, line.lineHeight - contentHeight);
        if (gap > 0) {
          const pad = gap / 2;
          runEl.style.paddingTop = `${pad}px`;
          runEl.style.paddingBottom = `${pad}px`;
        }
      }

      lineEl.append(runEl);

      // Measure text width for accurate tab position tracking
      const fontSize = run.fontSize || 11;
      const fontFamily = run.fontFamily || "Calibri";
      const measuredWidth = measureText(
        run.allCaps ? run.text.toLocaleUpperCase() : run.text,
        fontSize,
        fontFamily,
        {
          ...(run.bold !== undefined ? { bold: run.bold } : {}),
          ...(run.italic !== undefined ? { italic: run.italic } : {}),
          ...(run.letterSpacing !== undefined
            ? { letterSpacing: run.letterSpacing }
            : {}),
          ...(run.smallCaps !== undefined ? { smallCaps: run.smallCaps } : {}),
        },
      );
      reserveScaledAdvance(runEl, measuredWidth, run.horizontalScale);
      currentX += measuredWidth * ((run.horizontalScale ?? 100) / 100);
    } else if (isImageRun(run)) {
      // Skip floating images - they're rendered separately at page level.
      // Exception: inside table cells, floating images must render in-flow
      // Floating images are rendered in dedicated floating layers (page-level
      // or cell-level), not inline. Skip them here to avoid double rendering.
      if (isFloatingImageRun(run)) {
        continue;
      }
      const imageKey = getInlineImageRunKey(run);
      if (options?.renderedInlineImageKeys?.has(imageKey)) {
        continue;
      }
      options?.renderedInlineImageKeys?.add(imageKey);
      // Inline or block image - render in the text flow
      const runEl = renderImageRun(run, doc);
      lineEl.append(runEl);
      // Block images don't contribute to horizontal position
      if (run.displayMode !== "block" && run.wrapType !== "topAndBottom") {
        currentX += run.width;
      }
    } else if (isLineBreakRun(run)) {
      const runEl = renderLineBreakRun(run, doc);
      lineEl.append(runEl);
    } else if (isFieldRun(run) && options?.context) {
      // Render field run with context for PAGE/NUMPAGES substitution
      const runEl = renderFieldRun(run, doc, options.context);
      lineEl.append(runEl);
      // Estimate field text width for tab calculations
      let fieldText = run.fallback ?? "";
      if (run.fieldType === "PAGE") {
        fieldText = String(options.context.pageNumber);
      } else if (run.fieldType === "NUMPAGES") {
        fieldText = String(options.context.totalPages);
      }
      const fontSize = run.fontSize || 11;
      const fontFamily = run.fontFamily || "Calibri";
      const measuredWidth = measureText(
        run.allCaps ? fieldText.toLocaleUpperCase() : fieldText,
        fontSize,
        fontFamily,
        {
          ...(run.bold !== undefined ? { bold: run.bold } : {}),
          ...(run.italic !== undefined ? { italic: run.italic } : {}),
          ...(run.letterSpacing !== undefined
            ? { letterSpacing: run.letterSpacing }
            : {}),
          ...(run.smallCaps !== undefined ? { smallCaps: run.smallCaps } : {}),
        },
      );
      reserveScaledAdvance(runEl, measuredWidth, run.horizontalScale);
      currentX += measuredWidth * ((run.horizontalScale ?? 100) / 100);
    } else {
      // Fallback for unknown run types
      const runEl = renderRun(run, doc, options?.context);
      lineEl.append(runEl);
    }
  }

  return lineEl;
}

/**
 * Check if two individual border definitions are equal (same style, width, color).
 */
function bordersEqual(a?: BorderStyle, b?: BorderStyle): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.style === b.style && a.width === b.width && a.color === b.color;
}

/**
 * Check if two ParagraphBorders form a group (ECMA-376 §17.3.1.24).
 * Adjacent paragraphs with identical border definitions belong to the same group.
 */
function bordersFormGroup(a?: ParagraphBorders, b?: ParagraphBorders): boolean {
  if (!a && !b) {
    return false;
  } // no borders = no group
  if (!a || !b) {
    return false;
  }
  return (
    bordersEqual(a.top, b.top) &&
    bordersEqual(a.bottom, b.bottom) &&
    bordersEqual(a.left, b.left) &&
    bordersEqual(a.right, b.right) &&
    bordersEqual(a.between, b.between)
  );
}

/**
 * Render a paragraph fragment
 *
 * @param fragment - The fragment to render
 * @param block - The paragraph block
 * @param measure - The paragraph measurement
 * @param context - Rendering context
 * @param options - Rendering options
 * @returns The fragment DOM element
 */
export function renderParagraphFragment(
  fragment: ParagraphFragment,
  block: ParagraphBlock,
  measure: ParagraphMeasure,
  context: RenderContext,
  options: RenderParagraphOptions = {},
): HTMLElement {
  const doc = options.document ?? document;

  const fragmentEl = doc.createElement("div");
  fragmentEl.className = PARAGRAPH_CLASS_NAMES.fragment;
  fragmentEl.style.position = "relative"; // For absolute positioning of floating images

  // Store block and fragment metadata
  fragmentEl.dataset["blockId"] = String(fragment.blockId);
  fragmentEl.dataset["fromLine"] = String(fragment.fromLine);
  fragmentEl.dataset["toLine"] = String(fragment.toLine);

  applyPmPositions(fragmentEl, fragment.pmStart, fragment.pmEnd);

  if (fragment.continuesFromPrev) {
    fragmentEl.dataset["continuesFromPrev"] = "true";
  }
  if (fragment.continuesOnNext) {
    fragmentEl.dataset["continuesOnNext"] = "true";
  }

  // Text wrapping around floating images is handled at measurement time via
  // per-line leftOffset/rightOffset in MeasuredLine. Floating images themselves
  // skip inline rendering - they're rendered at page level.
  // NOTE: Floating images are rendered at page level in renderPage.ts for
  // cross-paragraph positioning. Inside table cells, they render in-flow
  // since page-level extraction doesn't reach into cell paragraphs.

  // Get the lines for this fragment
  const lines = measure.lines.slice(fragment.fromLine, fragment.toLine);
  const alignment = block.attrs?.alignment;

  // Apply paragraph-level styles
  if (block.attrs?.styleId) {
    fragmentEl.dataset["styleId"] = block.attrs.styleId;
  }

  // Apply RTL direction
  const isBidi = block.attrs?.bidi;
  if (isBidi) {
    fragmentEl.dir = "rtl";
  }

  // Apply text alignment at paragraph level
  // For justify: use text-align: left and apply word-spacing per line
  // For RTL paragraphs, default alignment is right
  if (alignment) {
    if (alignment === "center") {
      fragmentEl.style.textAlign = "center";
    } else if (alignment === "right") {
      fragmentEl.style.textAlign = "right";
    } else if (alignment === "left") {
      fragmentEl.style.textAlign = "left";
    } else {
      // 'justify' uses text-align: left (or right for RTL)
      // Justify is implemented via word-spacing on individual lines
      fragmentEl.style.textAlign = isBidi ? "right" : "left";
    }
  } else if (isBidi) {
    // No explicit alignment on RTL paragraph — default to right
    fragmentEl.style.textAlign = "right";
  }

  // Track indentation for line-level application
  // Indentation is applied per-line, not at fragment level
  const indent = block.attrs?.indent;
  let indentLeft = 0;
  let indentRight = 0;

  if (indent) {
    // Track indent values for line-level application
    // For RTL paragraphs, swap left/right indentation
    if (isBidi) {
      if (indent.left !== undefined) {
        indentRight = indent.left;
      }
      if (indent.right !== undefined) {
        indentLeft = indent.right;
      }
    } else {
      if (indent.left !== undefined) {
        indentLeft = indent.left;
      }
      if (indent.right !== undefined) {
        indentRight = indent.right;
      }
    }
  }

  // Note: Line spacing is applied per-line div (renderLine sets lineEl.style.height
  // and lineEl.style.lineHeight), not at fragment level. Fragment-level line-height
  // was removed to avoid conflicts with the explicit per-line pixel heights.

  // Apply borders
  const borders = block.attrs?.borders;
  if (borders) {
    const borderStyleToCss = (style?: string): string => {
      // Map OOXML border styles to CSS. The OOXML border-style enum has
      // 40+ decorative variants (threeDEmboss, wavyDouble, etc.); the
      // common ones below cover ~99% of real-world documents, and the
      // default falls back to a plain solid line — matches how Word
      // degrades on platforms without the specialised glyphs.
      switch (style) {
        case "single":
          return "solid";
        case "double":
          return "double";
        case "dotted":
          return "dotted";
        case "dashed":
          return "dashed";
        case "thick":
          return "solid";
        case "wave":
          return "wavy";
        case "dashSmallGap":
          return "dashed";
        case "nil":
        case "none":
          return "none";
        default:
          return "solid";
      }
    };

    // Ensure box-sizing is set for proper border calculations
    fragmentEl.style.boxSizing = "border-box";

    const borderToCss = (b: BorderStyle) =>
      `${b.width}px ${borderStyleToCss(b.style)} ${b.color}`;

    // Word-style border grouping (ECMA-376 §17.3.1.24):
    // Adjacent paragraphs with identical pBdr form a group.
    // - top border → only on the first paragraph of the group
    // - bottom border → only on the last paragraph of the group
    // - between border → rendered as borderTop on interior paragraphs
    // - left/right → on every paragraph in the group
    const groupedWithPrev = bordersFormGroup(options.prevBorders, borders);
    const groupedWithNext = bordersFormGroup(borders, options.nextBorders);

    // Paragraph borders paint on an absolutely positioned overlay so they
    // follow the text extents and indents rather than stretching across the
    // full paragraph fragment width.
    const renderedTopBorder = groupedWithPrev ? borders.between : borders.top;
    const renderedBottomBorder = !groupedWithNext ? borders.bottom : undefined;

    const borderBox = doc.createElement("div");
    borderBox.className = "layout-paragraph-border";
    borderBox.style.position = "absolute";
    borderBox.style.pointerEvents = "none";
    borderBox.style.boxSizing = "border-box";
    // With box-sizing: border-box, the border paints inside the box, so each
    // side's outer edge must shift outward by both `space` (text↔border gap
    // in OOXML §17.3.1.24) and the border width to keep the visible gap.
    borderBox.style.left = `${
      indentLeft - (borders.left?.space ?? 0) - (borders.left?.width ?? 0)
    }px`;
    borderBox.style.right = `${
      indentRight - (borders.right?.space ?? 0) - (borders.right?.width ?? 0)
    }px`;
    borderBox.style.top = `${
      -(renderedTopBorder?.space ?? 0) - (renderedTopBorder?.width ?? 0)
    }px`;
    borderBox.style.bottom = `${
      -(renderedBottomBorder?.space ?? 0) - (renderedBottomBorder?.width ?? 0)
    }px`;

    if (renderedTopBorder) {
      borderBox.style.borderTop = borderToCss(renderedTopBorder);
    }
    if (renderedBottomBorder) {
      borderBox.style.borderBottom = borderToCss(renderedBottomBorder);
    }
    if (borders.left) {
      borderBox.style.borderLeft = borderToCss(borders.left);
    }
    if (borders.right) {
      borderBox.style.borderRight = borderToCss(borders.right);
    }

    const hasBorder =
      renderedTopBorder ||
      renderedBottomBorder ||
      borders.left ||
      borders.right;
    if (hasBorder) {
      fragmentEl.style.position = "relative";
      fragmentEl.append(borderBox);
    }

    // Bar border — vertical decorative bar on the left side (ECMA-376 §17.3.1.4)
    // Rendered independently of the regular left border
    if (borders.bar) {
      const barEl = doc.createElement("div");
      barEl.style.position = "absolute";
      barEl.style.left = "-8px";
      barEl.style.top = "0";
      barEl.style.bottom = "0";
      barEl.style.borderLeft = borderToCss(borders.bar);
      fragmentEl.style.position = "relative";
      fragmentEl.append(barEl);
    }
  }

  // Apply shading (background color)
  if (block.attrs?.shading) {
    fragmentEl.style.backgroundColor = block.attrs.shading;
    const automaticTextColor = getAutomaticTextColorForBackground(
      block.attrs.shading,
    );
    if (automaticTextColor) {
      fragmentEl.style.color = automaticTextColor;
    }
  }

  // Calculate available width for justify
  // Subtract indentation since those are applied as CSS margins on the fragment
  const availableWidth = fragment.width - indentLeft - indentRight;

  // Check if paragraph ends with line break (for justify last line handling)
  const lastRun = block.runs.at(-1);
  const paragraphEndsWithLineBreak = lastRun?.kind === "lineBreak";

  // Total number of lines in the paragraph (not just this fragment)
  const totalLines = measure.lines.length;

  // Calculate first line indent for tab positioning
  // Hanging indent is stored as positive value but means negative offset for first line
  let firstLineIndentPx = 0;
  if (indent?.hanging && indent.hanging > 0) {
    firstLineIndentPx = -indent.hanging; // Negative because first line starts further left
  } else if (indent?.firstLine && indent.firstLine > 0) {
    firstLineIndentPx = indent.firstLine; // Positive because first line is indented right
  }

  // Render each line with per-line floating margin calculation
  let _cumulativeLineY = 0; // Track Y position within the fragment
  const renderedInlineImageKeys =
    options.renderedInlineImageKeys ?? new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!; // SAFETY: i < lines.length
    // Calculate the actual line index in the full paragraph
    const lineIndex = fragment.fromLine + i;
    const isLastLine = lineIndex === totalLines - 1;
    // First line of the paragraph (not just this fragment)
    const isFirstLine = lineIndex === 0 && !fragment.continuesFromPrev;

    // Get per-line floating margins from measurement phase
    const lineLeftOffset = line.leftOffset ?? 0;
    const lineRightOffset = line.rightOffset ?? 0;

    // For first line, adjust available width for hanging/firstLine indent
    // Measurement uses: baseFirstLineWidth = bodyContentWidth - (firstLine - hanging)
    // So hanging gives MORE width, firstLine gives LESS width
    let lineAvailableWidth = availableWidth;
    if (isFirstLine) {
      const hasHangingIndent = indent?.hanging && indent.hanging > 0;
      const hasFirstLineIndent = indent?.firstLine && indent.firstLine > 0;
      if (hasHangingIndent && indent.hanging) {
        lineAvailableWidth = availableWidth + indent.hanging;
      } else if (hasFirstLineIndent && indent.firstLine) {
        lineAvailableWidth = availableWidth - indent.firstLine;
      }
    }

    const lineEl = renderLine(block, line, alignment, doc, {
      availableWidth: lineAvailableWidth - lineLeftOffset - lineRightOffset,
      isLastLine,
      isFirstLine,
      paragraphEndsWithLineBreak,
      ...(block.attrs?.tabs !== undefined
        ? { tabStops: block.attrs.tabs }
        : {}),
      leftIndentPx: indentLeft,
      firstLineIndentPx: isFirstLine ? firstLineIndentPx : 0,
      context,
      floatingMargins: {
        leftMargin: lineLeftOffset,
        rightMargin: lineRightOffset,
      },
      renderedInlineImageKeys,
      // Absolute right edge in content-area coords. The fragment starts at
      // content-area-x=0 with full content-area width; the rightmost x where
      // inline content can land is `fragment.width - indentRight - lineRightOffset`.
      // Used by the right-tab anchor — see RenderLineOptions.lineRightEdgePx.
      lineRightEdgePx: fragment.width - indentRight - lineRightOffset,
    });

    // If renderLine promoted this line to flex (right-tab anchor for TOC
    // entries), text-indent must NOT apply: it would shift the first inline
    // content INSIDE EACH flex item (e.g. the page-number anchor), pulling
    // it left by `hanging`. Right-tab anchored lines re-apply the hanging
    // offset as margin-left on the first item inside renderLine itself.
    const isFlexLine = lineEl.dataset["flexLine"] === "true";

    // Apply left offset from floating images (lines start after the floating image)
    // Also constrain width so text doesn't overflow into the image area
    const lineMarginLeft = Math.min(indentLeft, 0) + lineLeftOffset;
    if (
      lineMarginLeft !== 0 ||
      lineRightOffset > 0 ||
      indentLeft < 0 ||
      indentRight < 0
    ) {
      lineEl.style.marginLeft = `${lineMarginLeft}px`;
      if (lineRightOffset > 0) {
        lineEl.style.marginRight = `${lineRightOffset}px`;
      }
      // Constrain line width to prevent text from extending into floating image area
      const constrainedWidth =
        lineAvailableWidth - lineLeftOffset - lineRightOffset;
      if (constrainedWidth > 0) {
        lineEl.style.width = `${constrainedWidth}px`;
      }
    }

    // Update cumulative Y for next line
    _cumulativeLineY += line.lineHeight;

    // Lead skip: a line bumped past obstructing floats reserves vertical
    // space above itself via marginTop. measureParagraph adds the same
    // amount to totalHeight so containers stay sized correctly.
    if (line.floatSkipBefore !== undefined && line.floatSkipBefore > 0) {
      lineEl.style.marginTop = `${line.floatSkipBefore}px`;
      _cumulativeLineY += line.floatSkipBefore;
    }

    // Apply line-level indentation
    // Indentation is applied per-line for correct text wrapping
    const hasHanging = indent?.hanging && indent.hanging > 0;
    const hasFirstLine = indent?.firstLine && indent.firstLine > 0;

    if (isFirstLine) {
      // First line handling
      if (indentLeft !== 0 && hasHanging) {
        // Hanging indent: first line starts at (indentLeft - hanging)
        lineEl.style.paddingLeft = `${Math.max(indentLeft, 0)}px`;
        if (!isFlexLine) {
          lineEl.style.textIndent = `-${indent.hanging ?? 0}px`;
        }
      } else if (indentLeft !== 0 && hasFirstLine) {
        // First line indent: first line starts at (indentLeft + firstLine)
        lineEl.style.paddingLeft = `${Math.max(indentLeft, 0)}px`;
        if (!isFlexLine) {
          lineEl.style.textIndent = `${indent.firstLine ?? 0}px`;
        }
      } else if (indentLeft > 0) {
        // Just left indent, no special first line treatment
        lineEl.style.paddingLeft = `${indentLeft}px`;
      } else if (hasFirstLine && !isFlexLine) {
        // No left indent, but has first line indent.
        lineEl.style.textIndent = `${indent.firstLine ?? 0}px`;
      }
      // No hanging without left indent (handled by firstLineOffset in measurement)
    } else if (indentLeft > 0) {
      // Body lines (not first line)
      lineEl.style.paddingLeft = `${indentLeft}px`;
    } else if (hasHanging) {
      // Hanging indent without left indent: body lines need padding = hanging
      lineEl.style.paddingLeft = `${indent.hanging ?? 0}px`;
    }

    if (indentRight > 0) {
      lineEl.style.paddingRight = `${indentRight}px`;
    }

    // Add list marker to first line
    // List first lines have special handling:
    // - Marker starts at (indentLeft - hanging)
    // - Text starts at indentLeft
    // - The marker box fills the hanging space
    if (
      isFirstLine &&
      block.attrs?.listMarker &&
      !block.attrs.listMarkerHidden
    ) {
      // Override padding for list first lines.
      //
      // Two list-indent shapes are common in OOXML:
      //
      // 1. Hanging — `<w:ind w:left="X" w:hanging="Y"/>`. Body text
      //    wraps at X, marker sits at X-Y (further left). The marker
      //    box fills the Y-px hanging space and the body text picks
      //    up at indentLeft.
      //
      // 2. First-line — `<w:ind w:left="X" w:firstLine="Y"/>`. Body
      //    text wraps at X, the FIRST line is shifted right by Y.
      //    Marker sits at X+Y; body text on subsequent lines wraps to
      //    the page margin (indentLeft). NVCA-style legal templates
      //    use this shape — the body of "(i) Tranche Closing..."
      //    wraps to the page margin, only the first line's marker is
      //    indented.
      const markerHasHanging =
        indent?.hanging !== undefined && indent.hanging > 0;
      const markerHasFirstLine =
        indent?.firstLine !== undefined && indent.firstLine > 0;
      let markerPos = indentLeft;
      if (markerHasHanging) {
        markerPos = Math.max(0, indentLeft - (indent.hanging ?? 0));
      } else if (markerHasFirstLine) {
        markerPos = indentLeft + (indent.firstLine ?? 0);
      }
      lineEl.style.paddingLeft = `${markerPos}px`;
      lineEl.style.textIndent = "0"; // Don't use textIndent for lists

      // Resolve marker font per ECMA-376 §17.9.6:
      // 1. Numbering level rPr (explicit marker font)
      // 2. First text run's font (paragraph content)
      // 3. Paragraph default font (from style)
      let firstTextRun: TextRun | undefined;
      if (
        !block.attrs.listMarkerFontFamily ||
        !block.attrs.listMarkerFontSize
      ) {
        for (let ri = line.fromRun; ri <= line.toRun; ri++) {
          const r = block.runs[ri];
          if (r && r.kind === "text") {
            firstTextRun = r;
            break;
          }
        }
      }
      const markerFontFamily =
        block.attrs.listMarkerFontFamily ??
        firstTextRun?.fontFamily ??
        block.attrs.defaultFontFamily;
      const markerFontSize =
        block.attrs.listMarkerFontSize ??
        firstTextRun?.fontSize ??
        block.attrs.defaultFontSize;

      const marker = renderListMarker(
        block.attrs.listMarker,
        getListMarkerInlineWidth(block),
        doc,
        markerFontFamily,
        markerFontSize,
      );
      lineEl.prepend(marker);
    }

    // Append line directly to fragment (per-line margins are applied in renderLine)
    fragmentEl.append(lineEl);
  }

  return fragmentEl;
}

/**
 * Render a list marker element as an inline-block at the start of the first
 * body line. `minWidth` (from `getListMarkerInlineWidth`) sizes the marker
 * so the body text aligns at the next tab stop per ECMA-376 §17.9.25 —
 * this honours `w:suff` (`tab` / `space` / `nothing`) and the document's
 * tab grid. Long markers like "1.1.1." therefore grow to the next stop
 * instead of butting against the body text.
 */
function renderListMarker(
  marker: string,
  minWidth: number,
  doc: Document,
  fontFamily?: string,
  fontSize?: number,
): HTMLElement {
  const span = doc.createElement("span");
  span.className = "layout-list-marker";
  span.style.display = "inline-block";

  // Per ECMA-376 §17.9.6, marker formatting comes from level rPr, then
  // paragraph defaults, then document defaults.
  if (fontFamily) {
    span.style.fontFamily = resolveFontFamily(fontFamily).cssFallback;
  }
  if (fontSize) {
    // 1pt = 96/72 px
    span.style.fontSize = `${(fontSize * 96) / 72}px`;
  }

  span.textContent = marker;
  span.style.textAlign = "left";
  span.style.boxSizing = "border-box";
  if (minWidth > 0) {
    span.style.minWidth = `${minWidth}px`;
  }

  return span;
}
