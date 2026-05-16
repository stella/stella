/**
 * Table Parser - Parse tables with full OOXML structure
 *
 * OOXML tables consist of:
 * - w:tbl - Table element
 * - w:tblPr - Table properties (width, borders, style)
 * - w:tblGrid - Column width definitions
 * - w:tr - Table rows
 * - w:trPr - Row properties (height, header)
 * - w:tc - Table cells
 * - w:tcPr - Cell properties (width, borders, merge)
 *
 * Cell merging:
 * - Horizontal: w:gridSpan (how many grid columns this cell spans)
 * - Vertical: w:vMerge (restart = start of merge, continue = continuation)
 *
 * OOXML Reference:
 * - w:tbl contains w:tblPr, w:tblGrid, and w:tr elements
 * - w:tr contains w:trPr and w:tc elements
 * - w:tc contains w:tcPr and content (paragraphs, tables)
 */

import type {
  Table,
  TableRow,
  TableCell,
  TableFormatting,
  TableRowFormatting,
  TableCellFormatting,
  TablePropertyChange,
  TableRowPropertyChange,
  TableCellPropertyChange,
  TableStructuralChangeInfo,
  TableMeasurement,
  TableWidthType,
  TableBorders,
  TableLook,
  CellMargins,
  FloatingTableProperties,
  ConditionalFormatStyle,
  Paragraph,
  Theme,
  BorderSpec,
  ShadingProperties,
  ColorValue,
  RelationshipMap,
  MediaFile,
} from "../types/document";
import type { NumberingMap } from "./numberingParser";
import { parseParagraph } from "./paragraphParser";
import {
  BorderStyleSchema,
  FloatingTableXSpecSchema,
  FloatingTableYSpecSchema,
  ShadingPatternSchema,
  TableCellTextDirectionSchema,
  ThemeColorSlotSchema,
  narrowEnum,
} from "./parserEnums";
import type { StyleMap } from "./styleParser";
import {
  findChild,
  findChildren,
  getAttribute,
  parseNumericAttribute,
  parseBooleanElement,
} from "./xmlParser";
import type { XmlElement } from "./xmlParser";

// ============================================================================
// TABLE MEASUREMENT PARSING
// ============================================================================

/**
 * Parse a table measurement (width, height, etc.)
 *
 * @param element - Element with w:w and w:type attributes
 * @returns Parsed measurement or undefined
 */
export function parseTableMeasurement(
  element: XmlElement | null,
): TableMeasurement | undefined {
  if (!element) {
    return undefined;
  }

  const value = parseNumericAttribute(element, "w", "w") ?? 0;
  const typeStr = getAttribute(element, "w", "type") ?? "dxa";

  let type: TableWidthType = "dxa";
  if (
    typeStr === "auto" ||
    typeStr === "dxa" ||
    typeStr === "nil" ||
    typeStr === "pct"
  ) {
    type = typeStr;
  }

  return { value, type };
}

/**
 * Parse width from an element (shorthand for common case)
 */
function parseWidth(element: XmlElement | null): TableMeasurement | undefined {
  return parseTableMeasurement(element);
}

function parseTrackedChangeInfo(
  node: XmlElement,
): TableStructuralChangeInfo["info"] {
  const rawId = getAttribute(node, "w", "id");
  const parsedId = rawId ? Number.parseInt(rawId, 10) : 0;
  const author = (getAttribute(node, "w", "author") ?? "").trim();
  const date = (getAttribute(node, "w", "date") ?? "").trim();

  const info: TableStructuralChangeInfo["info"] = {
    id: Number.isInteger(parsedId) && parsedId >= 0 ? parsedId : 0,
    author: author.length > 0 ? author : "Unknown",
  };
  if (date.length > 0) {
    info.date = date;
  }
  return info;
}

function parsePropertyChangeInfo(
  node: XmlElement,
):
  | TablePropertyChange["info"]
  | TableRowPropertyChange["info"]
  | TableCellPropertyChange["info"] {
  const base = parseTrackedChangeInfo(node);
  const rsid = (getAttribute(node, "w", "rsid") ?? "").trim();
  return rsid.length > 0 ? { ...base, rsid } : base;
}

// ============================================================================
// BORDER PARSING
// ============================================================================

/**
 * Parse a single border specification
 *
 * @param element - Border element (w:top, w:bottom, etc.)
 * @returns Parsed border or undefined
 */
export function parseBorderSpec(
  element: XmlElement | null,
): BorderSpec | undefined {
  if (!element) {
    return undefined;
  }

  // Unknown / missing border style → render no border (Word does the same).
  const style =
    narrowEnum(getAttribute(element, "w", "val"), BorderStyleSchema) ?? "none";

  const border: BorderSpec = { style };

  // Size in eighths of a point
  const sz = parseNumericAttribute(element, "w", "sz");
  if (sz !== undefined) {
    border.size = sz;
  }

  // Space from text in points
  const space = parseNumericAttribute(element, "w", "space");
  if (space !== undefined) {
    border.space = space;
  }

  // Color (border uses w:color, not w:val)
  const color = getAttribute(element, "w", "color");
  const themeColor = getAttribute(element, "w", "themeColor");
  const themeTint = getAttribute(element, "w", "themeTint");
  const themeShade = getAttribute(element, "w", "themeShade");
  if (color || themeColor || themeTint || themeShade) {
    const colorVal: ColorValue = {};
    if (color !== null) {
      colorVal.rgb = color;
    }
    const validatedThemeColor = narrowEnum(themeColor, ThemeColorSlotSchema);
    if (validatedThemeColor) {
      colorVal.themeColor = validatedThemeColor;
    }
    if (themeTint !== null) {
      colorVal.themeTint = themeTint;
    }
    if (themeShade !== null) {
      colorVal.themeShade = themeShade;
    }
    border.color = colorVal;
  }

  // Shadow effect
  const shadow = getAttribute(element, "w", "shadow");
  if (shadow === "1" || shadow === "true") {
    border.shadow = true;
  }

  // Frame effect
  const frame = getAttribute(element, "w", "frame");
  if (frame === "1" || frame === "true") {
    border.frame = true;
  }

  return border;
}

/**
 * Parse table borders (w:tblBorders or w:tcBorders)
 *
 * @param bordersElement - The borders container element
 * @returns Parsed borders or undefined
 */
export function parseTableBorders(
  bordersElement: XmlElement | null,
): TableBorders | undefined {
  if (!bordersElement) {
    return undefined;
  }

  const borders: TableBorders = {};

  const top = parseBorderSpec(findChild(bordersElement, "w", "top"));
  if (top) {
    borders.top = top;
  }

  const bottom = parseBorderSpec(findChild(bordersElement, "w", "bottom"));
  if (bottom) {
    borders.bottom = bottom;
  }

  const left = parseBorderSpec(
    findChild(bordersElement, "w", "left") ??
      findChild(bordersElement, "w", "start"),
  );
  if (left) {
    borders.left = left;
  }

  const right = parseBorderSpec(
    findChild(bordersElement, "w", "right") ??
      findChild(bordersElement, "w", "end"),
  );
  if (right) {
    borders.right = right;
  }

  const insideH = parseBorderSpec(findChild(bordersElement, "w", "insideH"));
  if (insideH) {
    borders.insideH = insideH;
  }

  const insideV = parseBorderSpec(findChild(bordersElement, "w", "insideV"));
  if (insideV) {
    borders.insideV = insideV;
  }

  // Return undefined if no borders were parsed
  if (Object.keys(borders).length === 0) {
    return undefined;
  }

  return borders;
}

// ============================================================================
// CELL MARGINS PARSING
// ============================================================================

/**
 * Parse cell margins (w:tblCellMar or w:tcMar)
 *
 * @param marginsElement - The margins container element
 * @returns Parsed margins or undefined
 */
export function parseCellMargins(
  marginsElement: XmlElement | null,
): CellMargins | undefined {
  if (!marginsElement) {
    return undefined;
  }

  const margins: CellMargins = {};

  const top = parseWidth(findChild(marginsElement, "w", "top"));
  if (top) {
    margins.top = top;
  }

  const bottom = parseWidth(findChild(marginsElement, "w", "bottom"));
  if (bottom) {
    margins.bottom = bottom;
  }

  const left = parseWidth(
    findChild(marginsElement, "w", "left") ??
      findChild(marginsElement, "w", "start"),
  );
  if (left) {
    margins.left = left;
  }

  const right = parseWidth(
    findChild(marginsElement, "w", "right") ??
      findChild(marginsElement, "w", "end"),
  );
  if (right) {
    margins.right = right;
  }

  if (Object.keys(margins).length === 0) {
    return undefined;
  }

  return margins;
}

// ============================================================================
// SHADING PARSING
// ============================================================================

/**
 * Parse shading properties (w:shd)
 *
 * @param shdElement - The w:shd element
 * @returns Parsed shading or undefined
 */
export function parseShading(
  shdElement: XmlElement | null,
): ShadingProperties | undefined {
  if (!shdElement) {
    return undefined;
  }

  const shading: ShadingProperties = {};

  // Fill color (background)
  const fillStr = getAttribute(shdElement, "w", "fill");
  if (fillStr && fillStr !== "auto") {
    shading.fill = { rgb: fillStr };
  }

  // Theme fill
  const themeFill = narrowEnum(
    getAttribute(shdElement, "w", "themeFill"),
    ThemeColorSlotSchema,
  );
  if (themeFill) {
    shading.fill = { themeColor: themeFill };

    const themeFillTint = getAttribute(shdElement, "w", "themeFillTint");
    if (themeFillTint) {
      shading.fill.themeTint = themeFillTint;
    }

    const themeFillShade = getAttribute(shdElement, "w", "themeFillShade");
    if (themeFillShade) {
      shading.fill.themeShade = themeFillShade;
    }
  }

  // Pattern color
  const colorStr = getAttribute(shdElement, "w", "color");
  if (colorStr && colorStr !== "auto") {
    shading.color = { rgb: colorStr };
  }

  // Pattern value
  const pattern = narrowEnum(
    getAttribute(shdElement, "w", "val"),
    ShadingPatternSchema,
  );
  if (pattern) {
    shading.pattern = pattern;
  }

  if (Object.keys(shading).length === 0) {
    return undefined;
  }

  return shading;
}

// ============================================================================
// TABLE LOOK PARSING
// ============================================================================

/**
 * Parse table look flags (w:tblLook)
 *
 * @param lookElement - The w:tblLook element
 * @returns Parsed table look or undefined
 */
export function parseTableLook(
  lookElement: XmlElement | null,
): TableLook | undefined {
  if (!lookElement) {
    return undefined;
  }

  const look: TableLook = {};

  // Parse individual flags
  const firstRow = getAttribute(lookElement, "w", "firstRow");
  if (firstRow === "1" || firstRow === "true") {
    look.firstRow = true;
  }

  const lastRow = getAttribute(lookElement, "w", "lastRow");
  if (lastRow === "1" || lastRow === "true") {
    look.lastRow = true;
  }

  const firstColumn = getAttribute(lookElement, "w", "firstColumn");
  if (firstColumn === "1" || firstColumn === "true") {
    look.firstColumn = true;
  }

  const lastColumn = getAttribute(lookElement, "w", "lastColumn");
  if (lastColumn === "1" || lastColumn === "true") {
    look.lastColumn = true;
  }

  const noHBand = getAttribute(lookElement, "w", "noHBand");
  if (noHBand === "1" || noHBand === "true") {
    look.noHBand = true;
  }

  const noVBand = getAttribute(lookElement, "w", "noVBand");
  if (noVBand === "1" || noVBand === "true") {
    look.noVBand = true;
  }

  // Also check for the val attribute (hexadecimal flags)
  const val = getAttribute(lookElement, "w", "val");
  if (val) {
    const flags = Number.parseInt(val, 16);
    if (!Number.isNaN(flags)) {
      // oxlint-disable-next-line no-bitwise
      if (flags & 0x00_20) {
        look.firstRow = true;
      }
      // oxlint-disable-next-line no-bitwise
      if (flags & 0x00_40) {
        look.lastRow = true;
      }
      // oxlint-disable-next-line no-bitwise
      if (flags & 0x00_80) {
        look.firstColumn = true;
      }
      // oxlint-disable-next-line no-bitwise
      if (flags & 0x01_00) {
        look.lastColumn = true;
      }
      // oxlint-disable-next-line no-bitwise
      if (flags & 0x02_00) {
        look.noHBand = true;
      }
      // oxlint-disable-next-line no-bitwise
      if (flags & 0x04_00) {
        look.noVBand = true;
      }
    }
  }

  if (Object.keys(look).length === 0) {
    return undefined;
  }

  return look;
}

// ============================================================================
// FLOATING TABLE PROPERTIES
// ============================================================================

/**
 * Parse floating table properties (w:tblpPr)
 *
 * @param tblpPrElement - The w:tblpPr element
 * @returns Parsed floating properties or undefined
 */
export function parseFloatingTableProperties(
  tblpPrElement: XmlElement | null,
): FloatingTableProperties | undefined {
  if (!tblpPrElement) {
    return undefined;
  }

  const floating: FloatingTableProperties = {};

  // Horizontal anchor
  const horzAnchor = getAttribute(tblpPrElement, "w", "horzAnchor");
  if (
    horzAnchor === "margin" ||
    horzAnchor === "page" ||
    horzAnchor === "text"
  ) {
    floating.horzAnchor = horzAnchor;
  }

  // Vertical anchor
  const vertAnchor = getAttribute(tblpPrElement, "w", "vertAnchor");
  if (
    vertAnchor === "margin" ||
    vertAnchor === "page" ||
    vertAnchor === "text"
  ) {
    floating.vertAnchor = vertAnchor;
  }

  // Horizontal position
  const tblpX = parseNumericAttribute(tblpPrElement, "w", "tblpX");
  if (tblpX !== undefined) {
    floating.tblpX = tblpX;
  }

  const tblpXSpec = narrowEnum(
    getAttribute(tblpPrElement, "w", "tblpXSpec"),
    FloatingTableXSpecSchema,
  );
  if (tblpXSpec) {
    floating.tblpXSpec = tblpXSpec;
  }

  // Vertical position
  const tblpY = parseNumericAttribute(tblpPrElement, "w", "tblpY");
  if (tblpY !== undefined) {
    floating.tblpY = tblpY;
  }

  const tblpYSpec = narrowEnum(
    getAttribute(tblpPrElement, "w", "tblpYSpec"),
    FloatingTableYSpecSchema,
  );
  if (tblpYSpec) {
    floating.tblpYSpec = tblpYSpec;
  }

  // Distance from text
  const topFromText = parseNumericAttribute(tblpPrElement, "w", "topFromText");
  if (topFromText !== undefined) {
    floating.topFromText = topFromText;
  }

  const bottomFromText = parseNumericAttribute(
    tblpPrElement,
    "w",
    "bottomFromText",
  );
  if (bottomFromText !== undefined) {
    floating.bottomFromText = bottomFromText;
  }

  const leftFromText = parseNumericAttribute(
    tblpPrElement,
    "w",
    "leftFromText",
  );
  if (leftFromText !== undefined) {
    floating.leftFromText = leftFromText;
  }

  const rightFromText = parseNumericAttribute(
    tblpPrElement,
    "w",
    "rightFromText",
  );
  if (rightFromText !== undefined) {
    floating.rightFromText = rightFromText;
  }

  if (Object.keys(floating).length === 0) {
    return undefined;
  }

  return floating;
}

// ============================================================================
// TABLE PROPERTIES PARSING (w:tblPr)
// ============================================================================

/**
 * Parse table properties (w:tblPr)
 *
 * @param tblPrElement - The w:tblPr element
 * @returns Parsed table formatting
 */
export function parseTableProperties(
  tblPrElement: XmlElement | null,
): TableFormatting | undefined {
  if (!tblPrElement) {
    return undefined;
  }

  const formatting: TableFormatting = {};

  // Table width (w:tblW)
  const width = parseWidth(findChild(tblPrElement, "w", "tblW"));
  if (width) {
    formatting.width = width;
  }

  // Table justification (w:jc)
  const jcElement = findChild(tblPrElement, "w", "jc");
  if (jcElement) {
    const jcVal = getAttribute(jcElement, "w", "val");
    if (
      jcVal === "left" ||
      jcVal === "center" ||
      jcVal === "right" ||
      jcVal === "start"
    ) {
      formatting.justification = jcVal === "start" ? "left" : jcVal;
    }
  }

  // Cell spacing (w:tblCellSpacing)
  const cellSpacing = parseWidth(
    findChild(tblPrElement, "w", "tblCellSpacing"),
  );
  if (cellSpacing) {
    formatting.cellSpacing = cellSpacing;
  }

  // Table indent (w:tblInd)
  const indent = parseWidth(findChild(tblPrElement, "w", "tblInd"));
  if (indent) {
    formatting.indent = indent;
  }

  // Table borders (w:tblBorders)
  const borders = parseTableBorders(findChild(tblPrElement, "w", "tblBorders"));
  if (borders) {
    formatting.borders = borders;
  }

  // Default cell margins (w:tblCellMar)
  const cellMargins = parseCellMargins(
    findChild(tblPrElement, "w", "tblCellMar"),
  );
  if (cellMargins) {
    formatting.cellMargins = cellMargins;
  }

  // Table layout (w:tblLayout)
  const layoutElement = findChild(tblPrElement, "w", "tblLayout");
  if (layoutElement) {
    const layoutVal = getAttribute(layoutElement, "w", "type");
    if (layoutVal === "fixed" || layoutVal === "autofit") {
      formatting.layout = layoutVal;
    }
  }

  // Table style (w:tblStyle)
  const styleElement = findChild(tblPrElement, "w", "tblStyle");
  if (styleElement) {
    const styleId = getAttribute(styleElement, "w", "val");
    if (styleId) {
      formatting.styleId = styleId;
    }
  }

  // Table look (w:tblLook)
  const look = parseTableLook(findChild(tblPrElement, "w", "tblLook"));
  if (look) {
    formatting.look = look;
  }

  // Shading (w:shd)
  const shading = parseShading(findChild(tblPrElement, "w", "shd"));
  if (shading) {
    formatting.shading = shading;
  }

  // Table overlap (w:tblOverlap)
  const overlapElement = findChild(tblPrElement, "w", "tblOverlap");
  if (overlapElement) {
    const overlapVal = getAttribute(overlapElement, "w", "val");
    if (overlapVal === "never" || overlapVal === "overlap") {
      formatting.overlap = overlapVal;
    }
  }

  // Floating table (w:tblpPr)
  const floating = parseFloatingTableProperties(
    findChild(tblPrElement, "w", "tblpPr"),
  );
  if (floating) {
    formatting.floating = floating;
  }

  // Bidirectional (w:bidiVisual)
  const bidi = parseBooleanElement(findChild(tblPrElement, "w", "bidiVisual"));
  if (bidi) {
    formatting.bidi = true;
  }

  if (Object.keys(formatting).length === 0) {
    return undefined;
  }

  return formatting;
}

function parseTablePropertyChanges(
  tblPrElement: XmlElement | null,
  currentFormatting: TableFormatting | undefined,
): TablePropertyChange[] | undefined {
  if (!tblPrElement) {
    return undefined;
  }

  const changes = findChildren(tblPrElement, "w", "tblPrChange")
    .map((changeElement): TablePropertyChange => {
      const previousTblPr = findChild(changeElement, "w", "tblPr");
      const change: TablePropertyChange = {
        type: "tablePropertyChange",
        info: parsePropertyChangeInfo(changeElement),
      };
      const prev = parseTableProperties(previousTblPr);
      if (prev !== undefined) {
        change.previousFormatting = prev;
      }
      if (currentFormatting !== undefined) {
        change.currentFormatting = currentFormatting;
      }
      return change;
    })
    .filter((change) => change.previousFormatting || change.currentFormatting);

  return changes.length > 0 ? changes : undefined;
}

function parseTableRowPropertyChanges(
  trPrElement: XmlElement | null,
  currentFormatting: TableRowFormatting | undefined,
): TableRowPropertyChange[] | undefined {
  if (!trPrElement) {
    return undefined;
  }

  const changes = findChildren(trPrElement, "w", "trPrChange")
    .map((changeElement): TableRowPropertyChange => {
      const previousTrPr = findChild(changeElement, "w", "trPr");
      const change: TableRowPropertyChange = {
        type: "tableRowPropertyChange",
        info: parsePropertyChangeInfo(changeElement),
      };
      const prev = parseTableRowProperties(previousTrPr);
      if (prev !== undefined) {
        change.previousFormatting = prev;
      }
      if (currentFormatting !== undefined) {
        change.currentFormatting = currentFormatting;
      }
      return change;
    })
    .filter((change) => change.previousFormatting || change.currentFormatting);

  return changes.length > 0 ? changes : undefined;
}

function parseTableCellPropertyChanges(
  tcPrElement: XmlElement | null,
  currentFormatting: TableCellFormatting | undefined,
): TableCellPropertyChange[] | undefined {
  if (!tcPrElement) {
    return undefined;
  }

  const changes = findChildren(tcPrElement, "w", "tcPrChange")
    .map((changeElement): TableCellPropertyChange => {
      const previousTcPr = findChild(changeElement, "w", "tcPr");
      const change: TableCellPropertyChange = {
        type: "tableCellPropertyChange",
        info: parsePropertyChangeInfo(changeElement),
      };
      const prev = parseTableCellProperties(previousTcPr);
      if (prev !== undefined) {
        change.previousFormatting = prev;
      }
      if (currentFormatting !== undefined) {
        change.currentFormatting = currentFormatting;
      }
      return change;
    })
    .filter((change) => change.previousFormatting || change.currentFormatting);

  return changes.length > 0 ? changes : undefined;
}

function parseTableRowStructuralChange(
  trPrElement: XmlElement | null,
): TableStructuralChangeInfo | undefined {
  if (!trPrElement) {
    return undefined;
  }

  const insertion = findChild(trPrElement, "w", "ins");
  if (insertion) {
    return {
      type: "tableRowInsertion",
      info: parseTrackedChangeInfo(insertion),
    };
  }

  const deletion = findChild(trPrElement, "w", "del");
  if (deletion) {
    return {
      type: "tableRowDeletion",
      info: parseTrackedChangeInfo(deletion),
    };
  }

  return undefined;
}

function parseTableCellStructuralChange(
  tcPrElement: XmlElement | null,
): TableStructuralChangeInfo | undefined {
  if (!tcPrElement) {
    return undefined;
  }

  const insertion = findChild(tcPrElement, "w", "cellIns");
  if (insertion) {
    return {
      type: "tableCellInsertion",
      info: parseTrackedChangeInfo(insertion),
    };
  }

  const deletion = findChild(tcPrElement, "w", "cellDel");
  if (deletion) {
    return {
      type: "tableCellDeletion",
      info: parseTrackedChangeInfo(deletion),
    };
  }

  const merge = findChild(tcPrElement, "w", "cellMerge");
  if (merge) {
    return {
      type: "tableCellMerge",
      info: parseTrackedChangeInfo(merge),
    };
  }

  return undefined;
}

// ============================================================================
// TABLE ROW PROPERTIES PARSING (w:trPr)
// ============================================================================

/**
 * Parse table row properties (w:trPr)
 *
 * @param trPrElement - The w:trPr element
 * @returns Parsed row formatting
 */
export function parseTableRowProperties(
  trPrElement: XmlElement | null,
): TableRowFormatting | undefined {
  if (!trPrElement) {
    return undefined;
  }

  const formatting: TableRowFormatting = {};

  // Row height (w:trHeight)
  // Note: w:trHeight uses w:val (not w:w) for the height value in twips.
  const heightElement = findChild(trPrElement, "w", "trHeight");
  if (heightElement) {
    const heightVal = parseNumericAttribute(heightElement, "w", "val");
    if (heightVal !== undefined && heightVal > 0) {
      formatting.height = { value: heightVal, type: "dxa" as const };
    }

    const hRule = getAttribute(heightElement, "w", "hRule");
    if (hRule === "auto" || hRule === "atLeast" || hRule === "exact") {
      formatting.heightRule = hRule;
    }
  }

  // Header row (w:tblHeader)
  const header = parseBooleanElement(findChild(trPrElement, "w", "tblHeader"));
  if (header) {
    formatting.header = true;
  }

  // Can't split (w:cantSplit)
  const cantSplit = parseBooleanElement(
    findChild(trPrElement, "w", "cantSplit"),
  );
  if (cantSplit) {
    formatting.cantSplit = true;
  }

  // Row justification (w:jc)
  const jcElement = findChild(trPrElement, "w", "jc");
  if (jcElement) {
    const jcVal = getAttribute(jcElement, "w", "val");
    if (jcVal === "left" || jcVal === "center" || jcVal === "right") {
      formatting.justification = jcVal;
    }
  }

  // Hidden row (w:hidden)
  const hidden = parseBooleanElement(findChild(trPrElement, "w", "hidden"));
  if (hidden) {
    formatting.hidden = true;
  }

  // Conditional format style (w:cnfStyle)
  const conditionalFormat = parseConditionalFormatStyle(
    findChild(trPrElement, "w", "cnfStyle"),
  );
  if (conditionalFormat) {
    formatting.conditionalFormat = conditionalFormat;
  }

  if (Object.keys(formatting).length === 0) {
    return undefined;
  }

  return formatting;
}

// ============================================================================
// TABLE CELL PROPERTIES PARSING (w:tcPr)
// ============================================================================

/**
 * Parse conditional format style (for table style conditional formatting)
 *
 * @param cnfElement - The w:cnfStyle element
 * @returns Parsed conditional format or undefined
 */
export function parseConditionalFormatStyle(
  cnfElement: XmlElement | null,
): ConditionalFormatStyle | undefined {
  if (!cnfElement) {
    return undefined;
  }

  const style: ConditionalFormatStyle = {};

  // Parse individual flags
  const firstRow = getAttribute(cnfElement, "w", "firstRow");
  if (firstRow === "1" || firstRow === "true") {
    style.firstRow = true;
  }

  const lastRow = getAttribute(cnfElement, "w", "lastRow");
  if (lastRow === "1" || lastRow === "true") {
    style.lastRow = true;
  }

  const firstColumn = getAttribute(cnfElement, "w", "firstColumn");
  if (firstColumn === "1" || firstColumn === "true") {
    style.firstColumn = true;
  }

  const lastColumn = getAttribute(cnfElement, "w", "lastColumn");
  if (lastColumn === "1" || lastColumn === "true") {
    style.lastColumn = true;
  }

  const oddHBand = getAttribute(cnfElement, "w", "oddHBand");
  if (oddHBand === "1" || oddHBand === "true") {
    style.oddHBand = true;
  }

  const evenHBand = getAttribute(cnfElement, "w", "evenHBand");
  if (evenHBand === "1" || evenHBand === "true") {
    style.evenHBand = true;
  }

  const oddVBand = getAttribute(cnfElement, "w", "oddVBand");
  if (oddVBand === "1" || oddVBand === "true") {
    style.oddVBand = true;
  }

  const evenVBand = getAttribute(cnfElement, "w", "evenVBand");
  if (evenVBand === "1" || evenVBand === "true") {
    style.evenVBand = true;
  }

  // Corner cells
  const nwCell = getAttribute(cnfElement, "w", "firstRowFirstColumn");
  if (nwCell === "1" || nwCell === "true") {
    style.nwCell = true;
  }

  const neCell = getAttribute(cnfElement, "w", "firstRowLastColumn");
  if (neCell === "1" || neCell === "true") {
    style.neCell = true;
  }

  const swCell = getAttribute(cnfElement, "w", "lastRowFirstColumn");
  if (swCell === "1" || swCell === "true") {
    style.swCell = true;
  }

  const seCell = getAttribute(cnfElement, "w", "lastRowLastColumn");
  if (seCell === "1" || seCell === "true") {
    style.seCell = true;
  }

  // Also check for the val attribute (binary flags string)
  const val = getAttribute(cnfElement, "w", "val");
  if (val && val.length === 12) {
    // Binary string format: XXXXXXXXXXXXXX
    // Position meanings from left to right
    if (val[0] === "1") {
      style.firstRow = true;
    }
    if (val[1] === "1") {
      style.lastRow = true;
    }
    if (val[2] === "1") {
      style.firstColumn = true;
    }
    if (val[3] === "1") {
      style.lastColumn = true;
    }
    if (val[4] === "1") {
      style.oddVBand = true;
    }
    if (val[5] === "1") {
      style.evenVBand = true;
    }
    if (val[6] === "1") {
      style.oddHBand = true;
    }
    if (val[7] === "1") {
      style.evenHBand = true;
    }
    if (val[8] === "1") {
      style.nwCell = true;
    }
    if (val[9] === "1") {
      style.neCell = true;
    }
    if (val[10] === "1") {
      style.swCell = true;
    }
    if (val[11] === "1") {
      style.seCell = true;
    }
  }

  if (Object.keys(style).length === 0) {
    return undefined;
  }

  return style;
}

/**
 * Parse table cell properties (w:tcPr)
 *
 * @param tcPrElement - The w:tcPr element
 * @returns Parsed cell formatting
 */
export function parseTableCellProperties(
  tcPrElement: XmlElement | null,
): TableCellFormatting | undefined {
  if (!tcPrElement) {
    return undefined;
  }

  const formatting: TableCellFormatting = {};

  // Cell width (w:tcW)
  const width = parseWidth(findChild(tcPrElement, "w", "tcW"));
  if (width) {
    formatting.width = width;
  }

  // Cell borders (w:tcBorders)
  const borders = parseTableBorders(findChild(tcPrElement, "w", "tcBorders"));
  if (borders) {
    formatting.borders = borders;
  }

  // Cell margins (w:tcMar)
  const margins = parseCellMargins(findChild(tcPrElement, "w", "tcMar"));
  if (margins) {
    formatting.margins = margins;
  }

  // Shading (w:shd)
  const shading = parseShading(findChild(tcPrElement, "w", "shd"));
  if (shading) {
    formatting.shading = shading;
  }

  // Vertical alignment (w:vAlign)
  const vAlignElement = findChild(tcPrElement, "w", "vAlign");
  if (vAlignElement) {
    const vAlign = getAttribute(vAlignElement, "w", "val");
    if (vAlign === "top" || vAlign === "center" || vAlign === "bottom") {
      formatting.verticalAlign = vAlign;
    }
  }

  // Text direction (w:textDirection)
  const textDirElement = findChild(tcPrElement, "w", "textDirection");
  if (textDirElement) {
    const textDir = narrowEnum(
      getAttribute(textDirElement, "w", "val"),
      TableCellTextDirectionSchema,
    );
    if (textDir) {
      formatting.textDirection = textDir;
    }
  }

  // Grid span (horizontal merge) (w:gridSpan)
  const gridSpanElement = findChild(tcPrElement, "w", "gridSpan");
  if (gridSpanElement) {
    const gridSpan = parseNumericAttribute(gridSpanElement, "w", "val");
    if (gridSpan !== undefined && gridSpan > 1) {
      formatting.gridSpan = gridSpan;
    }
  }

  // Vertical merge (w:vMerge)
  const vMergeElement = findChild(tcPrElement, "w", "vMerge");
  if (vMergeElement) {
    const vMergeVal = getAttribute(vMergeElement, "w", "val");
    if (vMergeVal === "restart") {
      formatting.vMerge = "restart";
    } else {
      // No val attribute or val="continue" means continuation
      formatting.vMerge = "continue";
    }
  }

  // Fit text (w:tcFitText)
  const fitText = parseBooleanElement(findChild(tcPrElement, "w", "tcFitText"));
  if (fitText) {
    formatting.fitText = true;
  }

  // No wrap (w:noWrap)
  const noWrap = parseBooleanElement(findChild(tcPrElement, "w", "noWrap"));
  if (noWrap) {
    formatting.noWrap = true;
  }

  // Hide mark (w:hideMark)
  const hideMark = parseBooleanElement(findChild(tcPrElement, "w", "hideMark"));
  if (hideMark) {
    formatting.hideMark = true;
  }

  // Conditional format style (w:cnfStyle)
  const conditionalFormat = parseConditionalFormatStyle(
    findChild(tcPrElement, "w", "cnfStyle"),
  );
  if (conditionalFormat) {
    formatting.conditionalFormat = conditionalFormat;
  }

  if (Object.keys(formatting).length === 0) {
    return undefined;
  }

  return formatting;
}

// ============================================================================
// CELL CONTENT PARSING
// ============================================================================

/**
 * Parse table cell content (paragraphs, nested tables)
 *
 * @param tcElement - The w:tc element
 * @param styles - Style definitions
 * @param theme - Theme for color/font resolution
 * @param numbering - Numbering definitions for lists
 * @param rels - Relationships for hyperlinks
 * @param media - Media files for images
 * @returns Array of content blocks
 */
function parseCellContent(
  tcElement: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null,
  options?: { inHeaderFooter?: boolean },
): (Paragraph | Table)[] {
  const content: (Paragraph | Table)[] = [];

  // Get all child elements
  const elements = tcElement.elements || [];

  for (const child of elements) {
    if (!child.name) {
      continue;
    }

    const localName = child.name.split(":").pop();

    if (localName === "p") {
      // Parse paragraph
      const para = parseParagraph(
        child,
        styles,
        theme,
        numbering,
        rels,
        media,
        options,
      );
      content.push(para);
    } else if (localName === "tbl") {
      // Parse nested table (recursive)
      const table = parseTable(
        child,
        styles,
        theme,
        numbering,
        rels,
        media,
        options,
      );
      content.push(table);
    }
    // Other content types in cells are rare but could be added
  }

  // Ensure at least one empty paragraph (Word requires this)
  if (content.length === 0) {
    content.push({
      type: "paragraph",
      content: [],
    });
  }

  return content;
}

// ============================================================================
// TABLE CELL PARSING
// ============================================================================

/**
 * Parse a table cell (w:tc)
 *
 * @param tcElement - The w:tc element
 * @param styles - Style definitions
 * @param theme - Theme for color/font resolution
 * @param numbering - Numbering definitions for lists
 * @param rels - Relationships for hyperlinks
 * @param media - Media files for images
 * @returns Parsed table cell
 */
export function parseTableCell(
  tcElement: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null,
  options?: { inHeaderFooter?: boolean },
): TableCell {
  const cell: TableCell = {
    type: "tableCell",
    content: [],
  };

  // Parse cell properties (w:tcPr)
  const tcPrElement = findChild(tcElement, "w", "tcPr");
  const formatting = parseTableCellProperties(tcPrElement);
  if (formatting) {
    cell.formatting = formatting;
  }
  const cellPropChanges = parseTableCellPropertyChanges(
    tcPrElement,
    formatting,
  );
  if (cellPropChanges !== undefined) {
    cell.propertyChanges = cellPropChanges;
  }
  const cellStructChange = parseTableCellStructuralChange(tcPrElement);
  if (cellStructChange !== undefined) {
    cell.structuralChange = cellStructChange;
  }

  // Parse content
  cell.content = parseCellContent(
    tcElement,
    styles,
    theme,
    numbering,
    rels,
    media,
    options,
  );

  return cell;
}

// ============================================================================
// TABLE ROW PARSING
// ============================================================================

/**
 * Parse a table row (w:tr)
 *
 * @param trElement - The w:tr element
 * @param styles - Style definitions
 * @param theme - Theme for color/font resolution
 * @param numbering - Numbering definitions for lists
 * @param rels - Relationships for hyperlinks
 * @param media - Media files for images
 * @returns Parsed table row
 */
export function parseTableRow(
  trElement: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null,
  options?: { inHeaderFooter?: boolean },
): TableRow {
  const row: TableRow = {
    type: "tableRow",
    cells: [],
  };

  // Parse row properties (w:trPr)
  const trPrElement = findChild(trElement, "w", "trPr");
  const formatting = parseTableRowProperties(trPrElement);
  if (formatting) {
    row.formatting = formatting;
  }
  const rowPropChanges = parseTableRowPropertyChanges(trPrElement, formatting);
  if (rowPropChanges !== undefined) {
    row.propertyChanges = rowPropChanges;
  }
  const rowStructChange = parseTableRowStructuralChange(trPrElement);
  if (rowStructChange !== undefined) {
    row.structuralChange = rowStructChange;
  }

  // Parse cells
  const cells = findChildren(trElement, "w", "tc");
  for (const cellElement of cells) {
    const cell = parseTableCell(
      cellElement,
      styles,
      theme,
      numbering,
      rels,
      media,
      options,
    );
    row.cells.push(cell);
  }

  return row;
}

// ============================================================================
// TABLE GRID PARSING
// ============================================================================

/**
 * Parse table grid (w:tblGrid) for column widths
 *
 * @param tblGridElement - The w:tblGrid element
 * @returns Array of column widths in twips
 */
export function parseTableGrid(
  tblGridElement: XmlElement | null,
): number[] | undefined {
  if (!tblGridElement) {
    return undefined;
  }

  const widths: number[] = [];

  const gridCols = findChildren(tblGridElement, "w", "gridCol");
  for (const col of gridCols) {
    const width = parseNumericAttribute(col, "w", "w") ?? 0;
    widths.push(width);
  }

  if (widths.length > 0 && widths.every((width) => width <= 0)) {
    return undefined;
  }

  return widths.length > 0 ? widths : undefined;
}

function hasRowGridOffsets(rowElement: XmlElement): boolean {
  const trPrElement = findChild(rowElement, "w", "trPr");
  if (!trPrElement) {
    return false;
  }

  const gridBefore =
    parseNumericAttribute(
      findChild(trPrElement, "w", "gridBefore"),
      "w",
      "val",
    ) ?? 0;
  const gridAfter =
    parseNumericAttribute(
      findChild(trPrElement, "w", "gridAfter"),
      "w",
      "val",
    ) ?? 0;

  return gridBefore > 0 || gridAfter > 0;
}

function getTableGridWidth(table: Table): number | null {
  const totalWidth = table.columnWidths?.reduce((sum, width) => sum + width, 0);
  if (!totalWidth || totalWidth <= 0) {
    return null;
  }
  return totalWidth;
}

function cellWidthCoversTableGrid(
  cell: TableCell,
  tableGridWidth: number | null,
): boolean {
  const width = cell.formatting?.width;
  if (!width || width.type !== "dxa" || tableGridWidth === null) {
    return false;
  }
  return width.value >= tableGridWidth;
}

function inferImplicitSingleCellRowSpans(
  table: Table,
  rowsWithGridOffsets: Set<number>,
): void {
  const gridColumnCount = table.columnWidths?.length ?? 0;
  if (gridColumnCount <= 1) {
    return;
  }

  const tableGridWidth = getTableGridWidth(table);
  if (tableGridWidth === null) {
    return;
  }

  for (const [rowIndex, row] of table.rows.entries()) {
    if (row.cells.length !== 1) {
      continue;
    }
    if (rowsWithGridOffsets.has(rowIndex)) {
      continue;
    }

    const cell = row.cells.at(0);
    if (!cell) {
      continue;
    }

    const currentSpan = cell.formatting?.gridSpan ?? 1;
    if (currentSpan >= gridColumnCount) {
      continue;
    }

    if (cell.formatting?.vMerge) {
      continue;
    }
    if (cell.formatting?.gridSpan != null) {
      continue;
    }
    if (!cellWidthCoversTableGrid(cell, tableGridWidth)) {
      continue;
    }

    cell.formatting = {
      ...cell.formatting,
      gridSpan: gridColumnCount,
    };
  }
}

// ============================================================================
// MAIN TABLE PARSING
// ============================================================================

/**
 * Parse a table element (w:tbl)
 *
 * @param tblElement - The w:tbl element
 * @param styles - Style definitions
 * @param theme - Theme for color/font resolution
 * @param numbering - Numbering definitions for lists
 * @param rels - Relationships for hyperlinks
 * @param media - Media files for images
 * @returns Parsed table
 */
export function parseTable(
  tblElement: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null,
  options?: { inHeaderFooter?: boolean },
): Table {
  const table: Table = {
    type: "table",
    rows: [],
  };

  // Parse table properties (w:tblPr)
  const tblPrElement = findChild(tblElement, "w", "tblPr");
  const formatting = parseTableProperties(tblPrElement);
  if (formatting) {
    table.formatting = formatting;
  }
  const tblPropChanges = parseTablePropertyChanges(tblPrElement, formatting);
  if (tblPropChanges !== undefined) {
    table.propertyChanges = tblPropChanges;
  }

  // Parse table grid (w:tblGrid)
  const columnWidths = parseTableGrid(findChild(tblElement, "w", "tblGrid"));
  if (columnWidths) {
    table.columnWidths = columnWidths;
  }

  // Parse rows
  const rows = findChildren(tblElement, "w", "tr");
  const rowsWithGridOffsets = new Set<number>();
  for (const [rowIndex, rowElement] of rows.entries()) {
    const row = parseTableRow(
      rowElement,
      styles,
      theme,
      numbering,
      rels,
      media,
      options,
    );
    table.rows.push(row);
    if (hasRowGridOffsets(rowElement)) {
      rowsWithGridOffsets.add(rowIndex);
    }
  }

  inferImplicitSingleCellRowSpans(table, rowsWithGridOffsets);

  return table;
}

// ============================================================================
// TABLE UTILITIES
// ============================================================================

/**
 * Get the number of columns in a table
 *
 * Uses the table grid if available, otherwise counts cells in first row.
 *
 * @param table - The table to measure
 * @returns Number of columns
 */
export function getTableColumnCount(table: Table): number {
  if (table.columnWidths && table.columnWidths.length > 0) {
    return table.columnWidths.length;
  }

  if (table.rows.length === 0) {
    return 0;
  }

  // SAFETY: rows.length > 0 verified above
  // Count cells in first row, accounting for grid span
  return table.rows[0]!.cells.reduce(
    (count, cell) => count + (cell.formatting?.gridSpan ?? 1),
    0,
  );
}

/**
 * Get the number of rows in a table
 *
 * @param table - The table to measure
 * @returns Number of rows
 */
export function getTableRowCount(table: Table): number {
  return table.rows.length;
}

/**
 * Check if a cell is part of a vertical merge
 *
 * @param cell - The cell to check
 * @returns true if cell continues a vertical merge
 */
export function isCellMergeContinuation(cell: TableCell): boolean {
  return cell.formatting?.vMerge === "continue";
}

/**
 * Check if a cell starts a vertical merge
 *
 * @param cell - The cell to check
 * @returns true if cell starts a vertical merge
 */
export function isCellMergeStart(cell: TableCell): boolean {
  return cell.formatting?.vMerge === "restart";
}

/**
 * Check if a cell spans multiple columns
 *
 * @param cell - The cell to check
 * @returns true if cell spans multiple columns
 */
export function isCellHorizontallyMerged(cell: TableCell): boolean {
  return (cell.formatting?.gridSpan ?? 1) > 1;
}

/**
 * Get the plain text content of a table
 *
 * @param table - The table to extract text from
 * @returns Plain text content
 */
export function getTableText(table: Table): string {
  const rows: string[] = [];

  for (const row of table.rows) {
    const cells: string[] = [];

    for (const cell of row.cells) {
      const cellText = cell.content
        .filter((c): c is Paragraph => c.type === "paragraph")
        .map((p) => getParagraphText(p))
        .join("\n");
      cells.push(cellText);
    }

    rows.push(cells.join("\t"));
  }

  return rows.join("\n");
}

/**
 * Helper to get paragraph text (simplified)
 */
function getParagraphText(para: Paragraph): string {
  return para.content
    .filter((c) => "content" in c)
    .flatMap((run) => {
      if (!("content" in run) || !Array.isArray(run.content)) {
        return [];
      }
      return run.content
        .filter(
          (c: unknown): c is { type: "text"; text: string } =>
            typeof c === "object" &&
            c !== null &&
            "type" in c &&
            c.type === "text" &&
            "text" in c,
        )
        .map((c) => c.text);
    })
    .join("");
}

/**
 * Check if table has header row
 *
 * @param table - The table to check
 * @returns true if first row is marked as header
 */
export function hasHeaderRow(table: Table): boolean {
  if (table.rows.length === 0) {
    return false;
  }
  // SAFETY: rows.length > 0 verified above
  return table.rows[0]!.formatting?.header === true;
}

/**
 * Get all header rows from a table
 *
 * @param table - The table to search
 * @returns Array of header rows
 */
export function getHeaderRows(table: Table): TableRow[] {
  return table.rows.filter((row) => row.formatting?.header === true);
}

/**
 * Check if table is a floating table
 *
 * @param table - The table to check
 * @returns true if table has floating properties
 */
export function isFloatingTable(table: Table): boolean {
  return table.formatting?.floating !== undefined;
}
