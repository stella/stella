/**
 * Shape Extension — inline shape node
 *
 * Renders basic shapes (rect, ellipse, line, etc.) as inline SVG elements.
 * Supports fill color, outline, transforms, and selection.
 */

import { expectShapeAttrs } from "../../attrs";
import type {
  ImagePositionAttrs,
  ShapeAttrs as SchemaShapeAttrs,
} from "../../schema/nodes";
import { createNodeExtension } from "../create";

export type ShapeAttrs = SchemaShapeAttrs;

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * CSS color allowlist for SVG attribute values.
 *
 * Why: shape colors round-trip through ProseMirror data-* attributes, so the
 * value is a CSS color string by the time it reaches the renderer. Accept the
 * shapes the parser produces (`#RRGGBB`, `var(--token, #RRGGBB)`) and a small
 * set of well-known keywords. Reject anything else so a crafted DOCX cannot
 * smuggle attribute-injection payloads or `url(...)` references.
 */
const HEX_COLOR_ATTR_RE = /^#[0-9A-Fa-f]{6}$/u;
const VAR_COLOR_RE = /^var\(--[a-z0-9-]+(?:,\s*#[0-9A-Fa-f]{6})?\)$/iu;
const NAMED_COLORS = new Set([
  "none",
  "transparent",
  "black",
  "white",
  "currentColor",
]);

export function sanitizeColor(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const v = value.trim();
  if (NAMED_COLORS.has(v)) {
    return v;
  }
  if (HEX_COLOR_ATTR_RE.test(v)) {
    return v;
  }
  if (VAR_COLOR_RE.test(v)) {
    return v;
  }
  return null;
}

const DISPLAY_MODES = new Set<NonNullable<ShapeAttrs["displayMode"]>>([
  "inline",
  "float",
  "block",
]);
const CSS_FLOATS = new Set<NonNullable<ShapeAttrs["cssFloat"]>>([
  "left",
  "right",
  "none",
]);

/**
 * CSS transform values for shape rotation/flips. Allow only the function calls
 * the parser actually emits (`rotate(Ndeg)`, `scaleX(-1)`, `scaleY(-1)`) so
 * a crafted DOCX cannot inject arbitrary CSS via the inline `style` attribute.
 */
const SAFE_TRANSFORM_TOKEN_RE =
  /^(?:rotate\(-?\d+(?:\.\d+)?deg\)|scaleX\(-1\)|scaleY\(-1\))$/u;

export function sanitizeTransform(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }
  const tokens = value.trim().split(/\s+/u);
  if (tokens.length === 0) {
    return null;
  }
  for (const t of tokens) {
    if (!SAFE_TRANSFORM_TOKEN_RE.test(t)) {
      return null;
    }
  }
  return tokens.join(" ");
}

function sanitizeDisplayMode(
  value: string | null | undefined,
): NonNullable<ShapeAttrs["displayMode"]> | null {
  for (const allowed of DISPLAY_MODES) {
    if (allowed === value) {
      return allowed;
    }
  }
  return null;
}

function sanitizeCssFloat(
  value: string | null | undefined,
): NonNullable<ShapeAttrs["cssFloat"]> | null {
  for (const allowed of CSS_FLOATS) {
    if (allowed === value) {
      return allowed;
    }
  }
  return null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseShapePosition(
  raw: string | undefined,
): ImagePositionAttrs | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    return parsed as ImagePositionAttrs;
  } catch {
    return undefined;
  }
}

function parseShapeLineEnd(
  raw: string | undefined,
): NonNullable<ShapeAttrs["outlineHeadEnd"]> | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    return parsed as NonNullable<ShapeAttrs["outlineHeadEnd"]>;
  } catch {
    return undefined;
  }
}

export function sanitizeSvgId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/gu, "");
  return sanitized.length > 0 ? sanitized : null;
}

export function sanitizeShapeDimension(
  value: number | null | undefined,
  fallback: number,
): number {
  return typeof value === "number" && !Number.isNaN(value) ? value : fallback;
}

function setNum(el: Element, name: string, value: number): void {
  el.setAttribute(name, String(value));
}

/**
 * Format a number for SVG attribute output: keeps integers as integers and
 * trims floating-point noise (e.g., `0.30000000000000004` → `0.3`).
 */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : Number(n.toFixed(3)).toString();
}

/**
 * Build the `points` string for a polygon-based shape preset.
 *
 * Phase-1 arrow proportions use Word's default `<a:avLst/>` percentages:
 *   - Stem thickness: 40% of the cross-axis extent.
 *   - Head depth: 40% of the main-axis extent.
 *   - Head width spans the full cross-axis extent.
 *
 * Pure and DOM-free so it can be unit tested without a happy-dom / jsdom
 * setup; `createShapeElement` wraps the result in an `<svg:polygon>` node.
 */
export function buildShapePolygonPoints(
  type: string,
  w: number,
  h: number,
): string | null {
  switch (type) {
    case "triangle":
    case "isosTriangle":
      return `${fmt(w / 2)},0 ${fmt(w)},${fmt(h)} 0,${fmt(h)}`;
    case "diamond":
      return `${fmt(w / 2)},0 ${fmt(w)},${fmt(h / 2)} ${fmt(w / 2)},${fmt(h)} 0,${fmt(h / 2)}`;
    case "rightArrow":
      return [
        `0,${fmt(h * 0.3)}`,
        `${fmt(w * 0.6)},${fmt(h * 0.3)}`,
        `${fmt(w * 0.6)},0`,
        `${fmt(w)},${fmt(h / 2)}`,
        `${fmt(w * 0.6)},${fmt(h)}`,
        `${fmt(w * 0.6)},${fmt(h * 0.7)}`,
        `0,${fmt(h * 0.7)}`,
      ].join(" ");
    case "leftArrow":
      return [
        `0,${fmt(h / 2)}`,
        `${fmt(w * 0.4)},0`,
        `${fmt(w * 0.4)},${fmt(h * 0.3)}`,
        `${fmt(w)},${fmt(h * 0.3)}`,
        `${fmt(w)},${fmt(h * 0.7)}`,
        `${fmt(w * 0.4)},${fmt(h * 0.7)}`,
        `${fmt(w * 0.4)},${fmt(h)}`,
      ].join(" ");
    case "upArrow":
      return [
        `${fmt(w / 2)},0`,
        `${fmt(w)},${fmt(h * 0.4)}`,
        `${fmt(w * 0.7)},${fmt(h * 0.4)}`,
        `${fmt(w * 0.7)},${fmt(h)}`,
        `${fmt(w * 0.3)},${fmt(h)}`,
        `${fmt(w * 0.3)},${fmt(h * 0.4)}`,
        `0,${fmt(h * 0.4)}`,
      ].join(" ");
    case "downArrow":
      return [
        `${fmt(w * 0.3)},0`,
        `${fmt(w * 0.7)},0`,
        `${fmt(w * 0.7)},${fmt(h * 0.6)}`,
        `${fmt(w)},${fmt(h * 0.6)}`,
        `${fmt(w / 2)},${fmt(h)}`,
        `0,${fmt(h * 0.6)}`,
        `${fmt(w * 0.3)},${fmt(h * 0.6)}`,
      ].join(" ");
    case "leftRightArrow":
      return [
        `0,${fmt(h / 2)}`,
        `${fmt(w * 0.25)},0`,
        `${fmt(w * 0.25)},${fmt(h * 0.3)}`,
        `${fmt(w * 0.75)},${fmt(h * 0.3)}`,
        `${fmt(w * 0.75)},0`,
        `${fmt(w)},${fmt(h / 2)}`,
        `${fmt(w * 0.75)},${fmt(h)}`,
        `${fmt(w * 0.75)},${fmt(h * 0.7)}`,
        `${fmt(w * 0.25)},${fmt(h * 0.7)}`,
        `${fmt(w * 0.25)},${fmt(h)}`,
      ].join(" ");
    case "upDownArrow":
      return [
        `${fmt(w / 2)},0`,
        `${fmt(w)},${fmt(h * 0.25)}`,
        `${fmt(w * 0.7)},${fmt(h * 0.25)}`,
        `${fmt(w * 0.7)},${fmt(h * 0.75)}`,
        `${fmt(w)},${fmt(h * 0.75)}`,
        `${fmt(w / 2)},${fmt(h)}`,
        `0,${fmt(h * 0.75)}`,
        `${fmt(w * 0.3)},${fmt(h * 0.75)}`,
        `${fmt(w * 0.3)},${fmt(h * 0.25)}`,
        `0,${fmt(h * 0.25)}`,
      ].join(" ");
    default:
      return null;
  }
}

/**
 * Build the inner shape element (rect/ellipse/etc) for the given shape type.
 *
 * Unknown / phase-2+ presets fall back to a rectangle so the document still
 * displays. The original `<a:prstGeom prst>` value round-trips through the
 * model regardless of what the renderer chooses to draw.
 */
function createShapeElement(type: string, w: number, h: number): SVGElement {
  switch (type) {
    case "ellipse":
    case "oval": {
      const el = document.createElementNS(SVG_NS, "ellipse");
      setNum(el, "cx", w / 2);
      setNum(el, "cy", h / 2);
      setNum(el, "rx", w / 2);
      setNum(el, "ry", h / 2);
      return el;
    }
    case "roundRect": {
      const el = document.createElementNS(SVG_NS, "rect");
      setNum(el, "x", 0);
      setNum(el, "y", 0);
      setNum(el, "width", w);
      setNum(el, "height", h);
      setNum(el, "rx", Math.min(w, h) * 0.1);
      return el;
    }
    case "line":
    case "straightConnector1": {
      const el = document.createElementNS(SVG_NS, "line");
      setNum(el, "x1", 0);
      setNum(el, "y1", h / 2);
      setNum(el, "x2", w);
      setNum(el, "y2", h / 2);
      return el;
    }
    default: {
      const points = buildShapePolygonPoints(type, w, h);
      if (points !== null) {
        const el = document.createElementNS(SVG_NS, "polygon");
        el.setAttribute("points", points);
        return el;
      }
      const el = document.createElementNS(SVG_NS, "rect");
      setNum(el, "x", 0);
      setNum(el, "y", 0);
      setNum(el, "width", w);
      setNum(el, "height", h);
      return el;
    }
  }
}

type GradientStop = { position: number; color: string };

function isGradientStopShape(
  value: unknown,
): value is { position: number; color: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { position?: unknown; color?: unknown };
  return (
    typeof candidate.position === "number" &&
    typeof candidate.color === "string"
  );
}

export function parseGradientStops(raw: string | undefined): GradientStop[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((s: unknown) => {
      if (!isGradientStopShape(s)) {
        return [];
      }
      const color = sanitizeColor(s.color);
      return color === null ? [] : [{ position: s.position, color }];
    });
  } catch {
    return [];
  }
}

/**
 * Create a gradient <defs> element. Returns null when stops are empty/invalid.
 */
function createGradientElement(
  gradId: string,
  attrs: ShapeAttrs,
): SVGElement | null {
  const stops = parseGradientStops(attrs.gradientStops);
  if (stops.length === 0) {
    return null;
  }

  const gType = attrs.gradientType ?? "linear";
  const isRadial =
    gType === "radial" || gType === "rectangular" || gType === "path";

  const grad = document.createElementNS(
    SVG_NS,
    isRadial ? "radialGradient" : "linearGradient",
  );
  grad.setAttribute("id", gradId);

  if (isRadial) {
    grad.setAttribute("cx", "50%");
    grad.setAttribute("cy", "50%");
    grad.setAttribute("r", "50%");
  } else {
    const angle = attrs.gradientAngle ?? 0;
    const rad = ((angle - 90) * Math.PI) / 180;
    const x1 = Math.round(50 + 50 * Math.cos(rad + Math.PI));
    const y1 = Math.round(50 + 50 * Math.sin(rad + Math.PI));
    const x2 = Math.round(50 + 50 * Math.cos(rad));
    const y2 = Math.round(50 + 50 * Math.sin(rad));
    grad.setAttribute("x1", `${x1}%`);
    grad.setAttribute("y1", `${y1}%`);
    grad.setAttribute("x2", `${x2}%`);
    grad.setAttribute("y2", `${y2}%`);
  }

  for (const s of stops) {
    const stop = document.createElementNS(SVG_NS, "stop");
    stop.setAttribute("offset", `${Math.round(s.position / 1000)}%`);
    stop.setAttribute("stop-color", s.color);
    grad.append(stop);
  }

  return grad;
}

export const ShapeExtension = createNodeExtension({
  name: "shape",
  schemaNodeName: "shape",
  nodeSpec: {
    inline: true,
    group: "inline",
    // Allow marks so an inserted/deleted shape can carry the tracked-change
    // mark (see ImageExtension — leaf inline atoms disallow marks by default).
    // eigenpal #641.
    marks: "_",
    draggable: true,
    atom: true,
    attrs: {
      shapeType: { default: "rect" },
      shapeId: { default: null },
      width: { default: 100 },
      height: { default: 80 },
      fillColor: { default: null },
      fillType: { default: "solid" },
      gradientType: { default: null },
      gradientAngle: { default: null },
      gradientStops: { default: null },
      outlineWidth: { default: 1 },
      outlineColor: { default: "var(--doc-shape-outline, #000000)" },
      outlineStyle: { default: "solid" },
      outlineCap: { default: null },
      outlineHeadEnd: { default: null },
      outlineTailEnd: { default: null },
      transform: { default: null },
      displayMode: { default: "inline" },
      cssFloat: { default: null },
      wrapType: { default: "inline" },
      wrapText: { default: null },
      distTop: { default: null },
      distBottom: { default: null },
      distLeft: { default: null },
      distRight: { default: null },
      position: { default: null },
      shadowColor: { default: null },
      shadowBlur: { default: null },
      shadowOffsetX: { default: null },
      shadowOffsetY: { default: null },
      glowColor: { default: null },
      glowRadius: { default: null },
    },
    parseDOM: [
      {
        tag: "span.docx-shape",
        getAttrs(dom): ShapeAttrs {
          const el = dom;
          const d = el.dataset;
          const position = parseShapePosition(d["position"]);
          const outlineHeadEnd = parseShapeLineEnd(d["outlineHeadEnd"]);
          const outlineTailEnd = parseShapeLineEnd(d["outlineTailEnd"]);
          return {
            shapeType: d["shapeType"] || "rect",
            ...(d["shapeId"] ? { shapeId: d["shapeId"] } : {}),
            ...(d["width"] ? { width: Number(d["width"]) } : {}),
            ...(d["height"] ? { height: Number(d["height"]) } : {}),
            ...(d["fillColor"] ? { fillColor: d["fillColor"] } : {}),
            fillType: (d["fillType"] || "solid") as NonNullable<
              ShapeAttrs["fillType"]
            >,
            ...(d["gradientType"]
              ? {
                  gradientType: d["gradientType"] as NonNullable<
                    ShapeAttrs["gradientType"]
                  >,
                }
              : {}),
            ...(d["gradientAngle"]
              ? { gradientAngle: Number(d["gradientAngle"]) }
              : {}),
            ...(d["gradientStops"]
              ? { gradientStops: d["gradientStops"] }
              : {}),
            ...(d["outlineWidth"]
              ? { outlineWidth: Number(d["outlineWidth"]) }
              : {}),
            ...(d["outlineColor"] ? { outlineColor: d["outlineColor"] } : {}),
            ...(d["outlineStyle"] ? { outlineStyle: d["outlineStyle"] } : {}),
            ...(d["outlineCap"]
              ? {
                  outlineCap: d["outlineCap"] as NonNullable<
                    ShapeAttrs["outlineCap"]
                  >,
                }
              : {}),
            ...(outlineHeadEnd ? { outlineHeadEnd } : {}),
            ...(outlineTailEnd ? { outlineTailEnd } : {}),
            ...(d["transform"] ? { transform: d["transform"] } : {}),
            ...(d["displayMode"]
              ? {
                  displayMode: d["displayMode"] as NonNullable<
                    ShapeAttrs["displayMode"]
                  >,
                }
              : {}),
            ...(d["cssFloat"]
              ? {
                  cssFloat: d["cssFloat"] as NonNullable<
                    ShapeAttrs["cssFloat"]
                  >,
                }
              : {}),
            ...(d["wrapType"]
              ? {
                  wrapType: d["wrapType"] as NonNullable<
                    ShapeAttrs["wrapType"]
                  >,
                }
              : {}),
            ...(d["wrapText"]
              ? {
                  wrapText: d["wrapText"] as NonNullable<
                    ShapeAttrs["wrapText"]
                  >,
                }
              : {}),
            ...(d["distTop"] ? { distTop: Number(d["distTop"]) } : {}),
            ...(d["distBottom"] ? { distBottom: Number(d["distBottom"]) } : {}),
            ...(d["distLeft"] ? { distLeft: Number(d["distLeft"]) } : {}),
            ...(d["distRight"] ? { distRight: Number(d["distRight"]) } : {}),
            ...(position ? { position } : {}),
            ...(d["shadowColor"] ? { shadowColor: d["shadowColor"] } : {}),
            ...(d["shadowBlur"] ? { shadowBlur: Number(d["shadowBlur"]) } : {}),
            ...(d["shadowOffsetX"]
              ? { shadowOffsetX: Number(d["shadowOffsetX"]) }
              : {}),
            ...(d["shadowOffsetY"]
              ? { shadowOffsetY: Number(d["shadowOffsetY"]) }
              : {}),
            ...(d["glowColor"] ? { glowColor: d["glowColor"] } : {}),
            ...(d["glowRadius"] ? { glowRadius: Number(d["glowRadius"]) } : {}),
          };
        },
      },
    ],
    toDOM(node) {
      const attrs = expectShapeAttrs(node);
      const w = sanitizeShapeDimension(attrs.width, 100);
      const h = sanitizeShapeDimension(attrs.height, 80);

      const domAttrs: Record<string, string> = {
        class: "docx-shape",
        "data-shape-type": attrs.shapeType || "rect",
      };

      // Data attributes for round-trip
      if (attrs.shapeId) {
        domAttrs["data-shape-id"] = attrs.shapeId;
      }
      domAttrs["data-width"] = String(w);
      domAttrs["data-height"] = String(h);
      if (attrs.fillColor) {
        domAttrs["data-fill-color"] = attrs.fillColor;
      }
      if (attrs.fillType) {
        domAttrs["data-fill-type"] = attrs.fillType;
      }
      if (attrs.gradientType) {
        domAttrs["data-gradient-type"] = attrs.gradientType;
      }
      if (typeof attrs.gradientAngle === "number") {
        domAttrs["data-gradient-angle"] = String(attrs.gradientAngle);
      }
      if (attrs.gradientStops) {
        domAttrs["data-gradient-stops"] = attrs.gradientStops;
      }
      if (attrs.outlineWidth) {
        domAttrs["data-outline-width"] = String(attrs.outlineWidth);
      }
      if (attrs.outlineColor) {
        domAttrs["data-outline-color"] = attrs.outlineColor;
      }
      if (attrs.outlineStyle) {
        domAttrs["data-outline-style"] = attrs.outlineStyle;
      }
      if (attrs.outlineCap) {
        domAttrs["data-outline-cap"] = attrs.outlineCap;
      }
      if (attrs.outlineHeadEnd) {
        domAttrs["data-outline-head-end"] = JSON.stringify(
          attrs.outlineHeadEnd,
        );
      }
      if (attrs.outlineTailEnd) {
        domAttrs["data-outline-tail-end"] = JSON.stringify(
          attrs.outlineTailEnd,
        );
      }
      if (attrs.transform) {
        domAttrs["data-transform"] = attrs.transform;
      }
      if (attrs.displayMode) {
        domAttrs["data-display-mode"] = attrs.displayMode;
      }
      if (attrs.cssFloat) {
        domAttrs["data-css-float"] = attrs.cssFloat;
      }
      if (attrs.wrapType) {
        domAttrs["data-wrap-type"] = attrs.wrapType;
      }
      if (attrs.wrapText) {
        domAttrs["data-wrap-text"] = attrs.wrapText;
      }
      if (typeof attrs.distTop === "number") {
        domAttrs["data-dist-top"] = String(attrs.distTop);
      }
      if (typeof attrs.distBottom === "number") {
        domAttrs["data-dist-bottom"] = String(attrs.distBottom);
      }
      if (typeof attrs.distLeft === "number") {
        domAttrs["data-dist-left"] = String(attrs.distLeft);
      }
      if (typeof attrs.distRight === "number") {
        domAttrs["data-dist-right"] = String(attrs.distRight);
      }
      if (attrs.position) {
        domAttrs["data-position"] = JSON.stringify(attrs.position);
      }
      if (attrs.shadowColor) {
        domAttrs["data-shadow-color"] = attrs.shadowColor;
      }
      if (typeof attrs.shadowBlur === "number") {
        domAttrs["data-shadow-blur"] = String(attrs.shadowBlur);
      }
      if (typeof attrs.shadowOffsetX === "number") {
        domAttrs["data-shadow-offset-x"] = String(attrs.shadowOffsetX);
      }
      if (typeof attrs.shadowOffsetY === "number") {
        domAttrs["data-shadow-offset-y"] = String(attrs.shadowOffsetY);
      }
      if (attrs.glowColor) {
        domAttrs["data-glow-color"] = attrs.glowColor;
      }
      if (typeof attrs.glowRadius === "number") {
        domAttrs["data-glow-radius"] = String(attrs.glowRadius);
      }

      // Sanitize untrusted values that flow into CSS/SVG attributes.
      const safeTransform = sanitizeTransform(attrs.transform);
      const safeDisplayMode = sanitizeDisplayMode(attrs.displayMode);
      const safeCssFloat = sanitizeCssFloat(attrs.cssFloat);
      const safeShadowColor = sanitizeColor(attrs.shadowColor);
      const safeGlowColor = sanitizeColor(attrs.glowColor);
      const safeGlowRadius = finiteNumber(attrs.glowRadius);
      const safeShadowBlur = finiteNumber(attrs.shadowBlur);
      const safeShadowOffsetX = finiteNumber(attrs.shadowOffsetX);
      const safeShadowOffsetY = finiteNumber(attrs.shadowOffsetY);

      // Build styles
      const styles: string[] = [
        "display: inline-block",
        `width: ${w}px`,
        `height: ${h}px`,
        "vertical-align: middle",
        "line-height: 0",
      ];

      if (safeTransform) {
        styles.push(`transform: ${safeTransform}`);
      }

      if (
        safeDisplayMode === "float" &&
        safeCssFloat &&
        safeCssFloat !== "none"
      ) {
        styles.push(`float: ${safeCssFloat}`);
        styles.push("margin: 4px 8px");
      } else if (safeDisplayMode === "block") {
        styles.push("display: block");
        styles.push("margin: 4px auto");
      }

      const filters: string[] = [];
      if (safeShadowColor) {
        const sx = safeShadowOffsetX ?? 2;
        const sy = safeShadowOffsetY ?? 2;
        const sb = safeShadowBlur ?? 4;
        filters.push(`drop-shadow(${sx}px ${sy}px ${sb}px ${safeShadowColor})`);
      }
      if (safeGlowColor !== null && safeGlowRadius !== null) {
        filters.push(`drop-shadow(0 0 ${safeGlowRadius}px ${safeGlowColor})`);
      }
      if (filters.length > 0) {
        styles.push(`filter: ${filters.join(" ")}`);
      }

      domAttrs["style"] = styles.join("; ");

      // Resolve fill / stroke colors. `none` is allowed; reject anything that
      // isn't a known color shape so it can't break out of the SVG attribute.
      const safeFillColor = sanitizeColor(attrs.fillColor) ?? "#ffffff";
      const safeStrokeColor =
        sanitizeColor(attrs.outlineColor) ??
        "var(--doc-shape-outline, #000000)";
      const strokeWidth = finiteNumber(attrs.outlineWidth) ?? 1;

      // Build SVG via DOM APIs so attribute values are escaped by the browser.
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("xmlns", SVG_NS);
      setNum(svg, "width", w);
      setNum(svg, "height", h);
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

      let gradient: SVGElement | null = null;
      let fillAttr: string;
      if (attrs.fillType === "gradient" && attrs.gradientStops) {
        const safeShapeId =
          sanitizeSvgId(attrs.shapeId) ??
          Math.random().toString(36).slice(2, 8);
        const gradId = `grad-${safeShapeId}`;
        gradient = createGradientElement(gradId, attrs);
        fillAttr = gradient ? `url(#${gradId})` : safeFillColor;
      } else {
        fillAttr = attrs.fillType === "none" ? "none" : safeFillColor;
      }

      svg.setAttribute(
        "style",
        `fill:${fillAttr};stroke:${safeStrokeColor};stroke-width:${strokeWidth}`,
      );

      if (gradient) {
        const defs = document.createElementNS(SVG_NS, "defs");
        defs.append(gradient);
        svg.append(defs);
      }

      const shapeEl = createShapeElement(attrs.shapeType || "rect", w, h);
      if (attrs.outlineStyle === "dashed") {
        shapeEl.setAttribute("stroke-dasharray", "8 4");
      } else if (attrs.outlineStyle === "dotted") {
        shapeEl.setAttribute("stroke-dasharray", "2 2");
      }
      svg.append(shapeEl);

      const span = document.createElement("span");
      for (const [key, value] of Object.entries(domAttrs)) {
        span.setAttribute(key, value);
      }
      span.append(svg);

      return { dom: span };
    },
  },
});
