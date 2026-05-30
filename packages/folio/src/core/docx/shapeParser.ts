/**
 * Shape Parser — parse DrawingML preset-geometry shapes from `<wps:wsp>`.
 *
 * Adapted from eigenpal docx-editor `shapeParser.ts`
 * (eigenpal/main:packages/core/src/docx/shapeParser.ts). Re-shaped to fit
 * folio's xml-parser helpers, picklist-based enum narrowing, and
 * exactOptionalPropertyTypes. The eigenpal version owned its own
 * fill/outline parser; folio already has `drawingUtils.parseFill` /
 * `parseOutline` so this module only extends them where gradient stops
 * and arrow-end metadata need more fidelity than the shared helpers
 * provide.
 *
 * OOXML structure (ECMA-376 §20.5.2 wordprocessingShape):
 *   w:drawing
 *     └── wp:inline | wp:anchor
 *         └── a:graphic
 *             └── a:graphicData
 *                 └── wps:wsp                  (the shape)
 *                     ├── wps:cNvPr            (id, name)
 *                     ├── wps:spPr             (shape properties)
 *                     │   ├── a:xfrm           (size + rotation)
 *                     │   ├── a:prstGeom       (preset geometry)
 *                     │   ├── a:solidFill / a:gradFill / a:noFill
 *                     │   └── a:ln             (outline + arrowheads)
 *                     ├── wps:txbx             (optional text body)
 *                     └── wps:bodyPr           (text body properties)
 */

import type {
  ColorValue,
  ImageSize,
  ImageTransform,
  Shape,
  ShapeFill,
  ShapeOutline,
} from "../types/document";
import {
  parseAnchorPosition,
  parseAnchorWrap,
  parseColorElement,
  parseFill as parseSpPrFill,
} from "./drawingUtils";
import {
  narrowEnum,
  ShapeOutlineStyleSchema,
  ShapeTypeSchema,
} from "./parserEnums";
import {
  findAllDeep,
  findChildByLocalName,
  findChildrenByLocalName,
  getAttribute,
  parseNumericAttribute,
} from "./xmlParser";
import type { XmlElement } from "./xmlParser";

/** Convert OOXML rotation (1/60000ths of a degree) to degrees. */
function rotToDegrees(rot: string | null | undefined): number | undefined {
  if (rot === null || rot === undefined) {
    return undefined;
  }
  const val = Number.parseInt(rot, 10);
  return Number.isNaN(val) ? undefined : val / 60_000;
}

// ---------------------------------------------------------------------------
// FILL — extends drawingUtils.parseFill with gradient stop fidelity
// ---------------------------------------------------------------------------

/**
 * Parse a fill with full gradient stop capture (eigenpal #21).
 * Falls through to `drawingUtils.parseFill` for solid / none cases.
 */
function parseShapeFill(spPr: XmlElement | null): ShapeFill | undefined {
  const base = parseSpPrFill(spPr);
  if (base?.type !== "gradient" || !spPr) {
    return base;
  }
  // Re-parse gradients locally for stop-level detail.
  const gradFill = findChildByLocalName(spPr, "gradFill");
  if (!gradFill) {
    return base;
  }
  return parseGradientFill(gradFill);
}

function parseGradientFill(gradFill: XmlElement): ShapeFill {
  let gradientType: "linear" | "radial" | "rectangular" | "path" = "linear";
  let angle: number | undefined;

  const lin = findChildByLocalName(gradFill, "lin");
  if (lin) {
    gradientType = "linear";
    const ang = getAttribute(lin, null, "ang");
    if (ang) {
      // Word stores `ang` in 60000ths of a degree, same as rotation.
      const parsed = Number.parseInt(ang, 10);
      angle = Number.isNaN(parsed) ? undefined : parsed / 60_000;
    }
  }

  const path = findChildByLocalName(gradFill, "path");
  if (path) {
    const pathType = getAttribute(path, null, "path");
    if (pathType === "circle") {
      gradientType = "radial";
    } else if (pathType === "rect") {
      gradientType = "rectangular";
    } else {
      gradientType = "path";
    }
  }

  const stops: { position: number; color: ColorValue }[] = [];
  const gsLst = findChildByLocalName(gradFill, "gsLst");
  if (gsLst) {
    for (const gs of findChildrenByLocalName(gsLst, "gs")) {
      const pos = getAttribute(gs, null, "pos");
      const position = pos ? Number.parseInt(pos, 10) : 0;
      const color = parseColorElement(gs);
      if (color) {
        stops.push({
          position: Number.isNaN(position) ? 0 : position,
          color,
        });
      }
    }
  }

  return {
    type: "gradient",
    gradient: {
      type: gradientType,
      ...(angle !== undefined ? { angle } : {}),
      stops,
    },
  };
}

// ---------------------------------------------------------------------------
// OUTLINE — extends drawingUtils.parseOutline with cap/join/end metadata
// ---------------------------------------------------------------------------

type LineEndType = NonNullable<ShapeOutline["headEnd"]>["type"];
type LineEndSize = NonNullable<ShapeOutline["headEnd"]>["width"];

const LINE_END_TYPES = new Set<LineEndType>([
  "none",
  "triangle",
  "stealth",
  "diamond",
  "oval",
  "arrow",
]);

function narrowLineEndType(value: string | null | undefined): LineEndType {
  if (value === null || value === undefined) {
    return "none";
  }
  for (const allowed of LINE_END_TYPES) {
    if (allowed === value) {
      return allowed;
    }
  }
  return "none";
}

function narrowLineEndSize(value: string | null | undefined): LineEndSize {
  if (value === "sm" || value === "med" || value === "lg") {
    return value;
  }
  return undefined;
}

function parseLineEnd(
  element: XmlElement,
): NonNullable<ShapeOutline["headEnd"]> {
  const type = narrowLineEndType(getAttribute(element, null, "type"));
  const width = narrowLineEndSize(getAttribute(element, null, "w"));
  const length = narrowLineEndSize(getAttribute(element, null, "len"));
  return {
    type,
    ...(width !== undefined ? { width } : {}),
    ...(length !== undefined ? { length } : {}),
  };
}

/**
 * Parse a shape outline with cap, join, and arrow end fidelity. Returns
 * `undefined` when the spPr has no `<a:ln>`, an explicit `<a:noFill/>`,
 * or no usable attributes.
 */
function parseShapeOutline(spPr: XmlElement | null): ShapeOutline | undefined {
  const ln = findChildByLocalName(spPr, "ln");
  if (!ln) {
    return undefined;
  }

  if (findChildByLocalName(ln, "noFill")) {
    return undefined;
  }

  const outline: ShapeOutline = {};

  const w = getAttribute(ln, null, "w");
  if (w) {
    const parsed = Number.parseInt(w, 10);
    if (!Number.isNaN(parsed)) {
      outline.width = parsed;
    }
  }

  const cap = getAttribute(ln, null, "cap");
  if (cap === "flat") {
    outline.cap = "flat";
  } else if (cap === "rnd") {
    outline.cap = "round";
  } else if (cap === "sq") {
    outline.cap = "square";
  }

  if (findChildByLocalName(ln, "bevel")) {
    outline.join = "bevel";
  } else if (findChildByLocalName(ln, "round")) {
    outline.join = "round";
  } else if (findChildByLocalName(ln, "miter")) {
    outline.join = "miter";
  }

  const solidFill = findChildByLocalName(ln, "solidFill");
  if (solidFill) {
    const color = parseColorElement(solidFill);
    if (color) {
      outline.color = color;
    }
  }

  const prstDash = findChildByLocalName(ln, "prstDash");
  if (prstDash) {
    const narrowed = narrowEnum(
      getAttribute(prstDash, null, "val"),
      ShapeOutlineStyleSchema,
    );
    if (narrowed !== undefined) {
      outline.style = narrowed;
    }
  }

  const headEnd = findChildByLocalName(ln, "headEnd");
  if (headEnd) {
    outline.headEnd = parseLineEnd(headEnd);
  }
  const tailEnd = findChildByLocalName(ln, "tailEnd");
  if (tailEnd) {
    outline.tailEnd = parseLineEnd(tailEnd);
  }

  if (
    outline.width === undefined &&
    outline.color === undefined &&
    outline.cap === undefined &&
    outline.join === undefined &&
    outline.style === undefined &&
    outline.headEnd === undefined &&
    outline.tailEnd === undefined
  ) {
    return undefined;
  }
  return outline;
}

// ---------------------------------------------------------------------------
// TRANSFORM (a:xfrm)
// ---------------------------------------------------------------------------

function parseTransform(xfrm: XmlElement | null): {
  size: ImageSize;
  transform?: ImageTransform;
} {
  if (!xfrm) {
    return { size: { width: 0, height: 0 } };
  }

  const ext = findChildByLocalName(xfrm, "ext");
  const cx = parseNumericAttribute(ext, null, "cx") ?? 0;
  const cy = parseNumericAttribute(ext, null, "cy") ?? 0;
  const size: ImageSize = { width: cx, height: cy };

  const rotation = rotToDegrees(getAttribute(xfrm, null, "rot"));
  const flipH = getAttribute(xfrm, null, "flipH") === "1";
  const flipV = getAttribute(xfrm, null, "flipV") === "1";

  if (rotation === undefined && !flipH && !flipV) {
    return { size };
  }
  const transform: ImageTransform = {};
  if (rotation !== undefined) {
    transform.rotation = rotation;
  }
  if (flipH) {
    transform.flipH = true;
  }
  if (flipV) {
    transform.flipV = true;
  }
  return { size, transform };
}

// ---------------------------------------------------------------------------
// SHAPE TYPE (a:prstGeom)
// ---------------------------------------------------------------------------

/**
 * Read `<a:prstGeom prst="…">` and narrow to the typed `ShapeType` union.
 * Unsupported geometry is not consumed as an editable shape because
 * `ShapeContent` currently serializes fresh preset geometry.
 */
function parseShapeType(spPr: XmlElement | null): Shape["shapeType"] {
  if (!spPr) {
    return "rect";
  }
  const prstGeom = findChildByLocalName(spPr, "prstGeom");
  if (prstGeom) {
    const prst = getAttribute(prstGeom, null, "prst");
    const narrowed = narrowEnum(prst, ShapeTypeSchema);
    if (narrowed) {
      return narrowed;
    }
  }
  return "rect";
}

function hasUnsupportedGeometry(spPr: XmlElement | null): boolean {
  if (!spPr) {
    return false;
  }
  const prstGeom = findChildByLocalName(spPr, "prstGeom");
  if (!prstGeom) {
    return findChildByLocalName(spPr, "custGeom") !== null;
  }
  const avLst = findChildByLocalName(prstGeom, "avLst");
  if (avLst?.elements?.some((child) => child.type === "element")) {
    return true;
  }
  const prst = getAttribute(prstGeom, null, "prst");
  return narrowEnum(prst, ShapeTypeSchema) === undefined;
}

function hasUnsupportedRgbColorModifiers(spPr: XmlElement | null): boolean {
  for (const color of findAllDeep(spPr, "a", "srgbClr")) {
    if (color.elements?.some((child) => child.type === "element")) {
      return true;
    }
  }
  return false;
}

function colorNeedsRawPreservation(color: ColorValue | undefined): boolean {
  return color !== undefined && color.rgb === undefined;
}

function fillNeedsRawPreservation(fill: ShapeFill | undefined): boolean {
  if (!fill) {
    return false;
  }
  if (fill.type === "solid") {
    return colorNeedsRawPreservation(fill.color);
  }
  if (fill.type === "gradient") {
    return (
      fill.gradient?.stops.some((stop) =>
        colorNeedsRawPreservation(stop.color),
      ) ?? false
    );
  }
  return false;
}

function outlineNeedsRawPreservation(
  outline: ShapeOutline | undefined,
): boolean {
  return colorNeedsRawPreservation(outline?.color);
}

// ---------------------------------------------------------------------------
// MAIN ENTRY POINTS
// ---------------------------------------------------------------------------

/**
 * Parse a `<wps:wsp>` element into a Shape model. Does NOT pick up the
 * extent / position / wrap fields — those live on the wrapping
 * `<wp:inline>` / `<wp:anchor>` and are handled by `parseShapeFromDrawing`.
 */
export function parseShape(node: XmlElement): Shape {
  const cNvPr = findChildByLocalName(node, "cNvPr");
  const spPr = findChildByLocalName(node, "spPr");

  const shapeType = parseShapeType(spPr);
  const xfrm = findChildByLocalName(spPr, "xfrm");
  const { size, transform } = parseTransform(xfrm);
  const fill = parseShapeFill(spPr);
  const outline = parseShapeOutline(spPr);

  const id = cNvPr ? (getAttribute(cNvPr, null, "id") ?? undefined) : undefined;
  const name = cNvPr
    ? (getAttribute(cNvPr, null, "name") ?? undefined)
    : undefined;

  const shape: Shape = {
    type: "shape",
    shapeType,
    size,
  };
  if (id !== undefined) {
    shape.id = id;
  }
  if (name !== undefined) {
    shape.name = name;
  }
  if (fill !== undefined) {
    shape.fill = fill;
  }
  if (outline !== undefined) {
    shape.outline = outline;
  }
  if (transform !== undefined) {
    shape.transform = transform;
  }
  return shape;
}

/**
 * Parse a `<w:drawing>` element as a shape (i.e. the `<a:graphicData>` payload
 * is `<wps:wsp>`, not `<pic:pic>` or a text-box). Returns null when the
 * drawing is not a shape, or when it is a text-box (delegated to
 * `textBoxParser.parseTextBox`).
 */
export function parseShapeFromDrawing(drawingEl: XmlElement): Shape | null {
  const inline = findChildByLocalName(drawingEl, "inline");
  const anchor = findChildByLocalName(drawingEl, "anchor");
  const container = inline ?? anchor;
  if (!container) {
    return null;
  }

  const graphic = findChildByLocalName(container, "graphic");
  if (!graphic) {
    return null;
  }
  const graphicData = findChildByLocalName(graphic, "graphicData");
  if (!graphicData) {
    return null;
  }
  const wsp = findChildByLocalName(graphicData, "wsp");
  if (!wsp) {
    return null;
  }
  // Text boxes go through textBoxParser, not here; they carry their own
  // content tree that the block parser threads through paragraphs.
  if (findChildByLocalName(wsp, "txbx") !== null) {
    return null;
  }

  const spPr = findChildByLocalName(wsp, "spPr");
  if (
    hasUnsupportedGeometry(spPr) ||
    hasUnsupportedRgbColorModifiers(spPr) ||
    fillNeedsRawPreservation(parseShapeFill(spPr)) ||
    outlineNeedsRawPreservation(parseShapeOutline(spPr))
  ) {
    return null;
  }

  const shape = parseShape(wsp);

  // The container's wp:extent supersedes spPr's a:ext when both exist.
  const extent = findChildByLocalName(container, "extent");
  if (extent) {
    const cx = parseNumericAttribute(extent, null, "cx") ?? shape.size.width;
    const cy = parseNumericAttribute(extent, null, "cy") ?? shape.size.height;
    shape.size = { width: cx, height: cy };
  }

  const isAnchor = container === anchor;
  if (isAnchor) {
    const position = parseAnchorPosition(container);
    if (position) {
      shape.position = position;
    }
    const wrap = parseAnchorWrap(container);
    if (wrap) {
      shape.wrap = wrap;
    }
  } else {
    shape.wrap = { type: "inline" };
  }

  const docPr = findChildByLocalName(container, "docPr");
  if (docPr) {
    const id = getAttribute(docPr, null, "id");
    const name = getAttribute(docPr, null, "name");
    if (id !== null) {
      shape.id = id;
    }
    if (name !== null) {
      shape.name = name;
    }
  }

  return shape;
}

export function shouldPreserveRawShapeDrawing(drawingEl: XmlElement): boolean {
  const inline = findChildByLocalName(drawingEl, "inline");
  const anchor = findChildByLocalName(drawingEl, "anchor");
  const container = inline ?? anchor;
  if (!container) {
    return false;
  }
  const graphic = findChildByLocalName(container, "graphic");
  const graphicData = graphic
    ? findChildByLocalName(graphic, "graphicData")
    : null;
  const wsp = graphicData ? findChildByLocalName(graphicData, "wsp") : null;
  if (!wsp || findChildByLocalName(wsp, "txbx") !== null) {
    return false;
  }
  const spPr = findChildByLocalName(wsp, "spPr");
  if (hasUnsupportedGeometry(spPr)) {
    return true;
  }
  if (hasUnsupportedRgbColorModifiers(spPr)) {
    return true;
  }
  return (
    fillNeedsRawPreservation(parseShapeFill(spPr)) ||
    outlineNeedsRawPreservation(parseShapeOutline(spPr))
  );
}
