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
import { narrowEnum, ShapeTypeSchema } from "./parserEnums";
import {
  findByFullName,
  findChildrenByLocalName,
  getAttribute,
  getChildElements,
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
  const children = getChildElements(spPr);
  const gradFill = children.find((el) => el.name === "a:gradFill");
  if (!gradFill) {
    return base;
  }
  return parseGradientFill(gradFill);
}

function parseGradientFill(gradFill: XmlElement): ShapeFill {
  const children = getChildElements(gradFill);

  let gradientType: "linear" | "radial" | "rectangular" | "path" = "linear";
  let angle: number | undefined;

  const lin = children.find((el) => el.name === "a:lin");
  if (lin) {
    gradientType = "linear";
    const ang = getAttribute(lin, null, "ang");
    if (ang) {
      // Word stores `ang` in 60000ths of a degree, same as rotation.
      const parsed = Number.parseInt(ang, 10);
      angle = Number.isNaN(parsed) ? undefined : parsed / 60_000;
    }
  }

  const path = children.find((el) => el.name === "a:path");
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
  const gsLst = children.find((el) => el.name === "a:gsLst");
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
  const ln = spPr ? findByFullName(spPr, "a:ln") : null;
  if (!ln) {
    return undefined;
  }

  const children = getChildElements(ln);
  if (children.some((el) => el.name === "a:noFill")) {
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

  if (children.some((el) => el.name === "a:bevel")) {
    outline.join = "bevel";
  } else if (children.some((el) => el.name === "a:round")) {
    outline.join = "round";
  } else if (children.some((el) => el.name === "a:miter")) {
    outline.join = "miter";
  }

  const solidFill = children.find((el) => el.name === "a:solidFill");
  if (solidFill) {
    const color = parseColorElement(solidFill);
    if (color) {
      outline.color = color;
    }
  }

  const prstDash = children.find((el) => el.name === "a:prstDash");
  if (prstDash) {
    const val = getAttribute(prstDash, null, "val");
    const narrowed = narrowShapeOutlineStyle(val);
    if (narrowed !== undefined) {
      outline.style = narrowed;
    }
  }

  const headEnd = children.find((el) => el.name === "a:headEnd");
  if (headEnd) {
    outline.headEnd = parseLineEnd(headEnd);
  }
  const tailEnd = children.find((el) => el.name === "a:tailEnd");
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

const OUTLINE_STYLE_VALUES = new Set<NonNullable<ShapeOutline["style"]>>([
  "solid",
  "dot",
  "dash",
  "lgDash",
  "dashDot",
  "lgDashDot",
  "lgDashDotDot",
  "sysDot",
  "sysDash",
  "sysDashDot",
  "sysDashDotDot",
]);

function narrowShapeOutlineStyle(
  value: string | null | undefined,
): NonNullable<ShapeOutline["style"]> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  for (const allowed of OUTLINE_STYLE_VALUES) {
    if (allowed === value) {
      return allowed;
    }
  }
  return undefined;
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

  const ext = findByFullName(xfrm, "a:ext");
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
 * Unknown values fall back to `rect`, matching Word's degenerate behaviour;
 * `<a:custGeom>` also falls back to `rect` for phase-1 rendering while the
 * original XML survives the round-trip via the rezip path.
 */
function parseShapeType(spPr: XmlElement | null): Shape["shapeType"] {
  if (!spPr) {
    return "rect";
  }
  const prstGeom = findByFullName(spPr, "a:prstGeom");
  if (prstGeom) {
    const prst = getAttribute(prstGeom, null, "prst");
    const narrowed = narrowEnum(prst, ShapeTypeSchema);
    if (narrowed) {
      return narrowed;
    }
  }
  // Custom geometry: phase-3 will replay <a:pathLst>. Phase-1 falls back to
  // rect for display while preserving the XML via rawXml at the run level.
  return "rect";
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
  const children = getChildElements(node);

  const cNvPr = children.find((el) => el.name === "wps:cNvPr");
  const spPr = children.find((el) => el.name === "wps:spPr") ?? null;

  const shapeType = parseShapeType(spPr);
  const xfrm = spPr ? findByFullName(spPr, "a:xfrm") : null;
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
  const children = getChildElements(drawingEl);
  const container = children.find(
    (el) => el.name === "wp:inline" || el.name === "wp:anchor",
  );
  if (!container) {
    return null;
  }

  const graphic = findByFullName(container, "a:graphic");
  if (!graphic) {
    return null;
  }
  const graphicData = findByFullName(graphic, "a:graphicData");
  if (!graphicData) {
    return null;
  }
  const wsp = findByFullName(graphicData, "wps:wsp");
  if (!wsp) {
    return null;
  }
  // Text boxes go through textBoxParser, not here; they carry their own
  // content tree that the block parser threads through paragraphs.
  if (findByFullName(wsp, "wps:txbx") !== null) {
    return null;
  }

  const shape = parseShape(wsp);

  // The container's wp:extent supersedes spPr's a:ext when both exist.
  const extent = findByFullName(container, "wp:extent");
  if (extent) {
    const cx = parseNumericAttribute(extent, null, "cx") ?? shape.size.width;
    const cy = parseNumericAttribute(extent, null, "cy") ?? shape.size.height;
    shape.size = { width: cx, height: cy };
  }

  const isAnchor = container.name === "wp:anchor";
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

  const docPr = findByFullName(container, "wp:docPr");
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

/**
 * True when the drawing element contains a non-text-box `<wps:wsp>` shape.
 */
export function isShapeDrawing(drawingEl: XmlElement): boolean {
  const children = getChildElements(drawingEl);
  const container = children.find(
    (el) => el.name === "wp:inline" || el.name === "wp:anchor",
  );
  if (!container) {
    return false;
  }
  const graphic = findByFullName(container, "a:graphic");
  if (!graphic) {
    return false;
  }
  const graphicData = findByFullName(graphic, "a:graphicData");
  if (!graphicData) {
    return false;
  }
  const wsp = findByFullName(graphicData, "wps:wsp");
  if (!wsp) {
    return false;
  }
  return findByFullName(wsp, "wps:txbx") === null;
}
