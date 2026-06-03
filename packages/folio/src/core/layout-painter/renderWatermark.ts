/**
 * Watermark painter — renders the document watermark behind page content.
 *
 * Word stores watermarks as VML shapes inside header parts (the parser
 * captures these into `HeaderFooter.watermark`). On screen we render
 * them as an absolutely-positioned overlay below the content z-index so
 * text and floating images draw over them. The DOM here is intentionally
 * simple (one wrapper + one content element); the visual fidelity comes
 * from CSS transforms rather than mirroring VML's `v:textpath` shape.
 */

import type { Page } from "../layout-engine/types";
import type { Watermark } from "../types/document";
import { resolveFontFamily } from "../utils/fontResolver";

const WATERMARK_CLASS = "layout-page-watermark";

export type RenderWatermarkOptions = {
  /** Resolved image src for picture watermarks (data URL or http URL). */
  imageSrc?: string;
};

/**
 * Build the watermark overlay element for a page. Returns `null` when
 * the watermark is a picture without a resolved `imageSrc` (the
 * relationship-id resolver lives outside the painter; without a src
 * there's nothing visible to draw).
 */
export function renderWatermarkLayer(
  watermark: Watermark,
  page: Page,
  doc: Document,
  options: RenderWatermarkOptions = {},
): HTMLElement | null {
  if (watermark.kind === "picture" && !options.imageSrc) {
    return null;
  }
  const layer = doc.createElement("div");
  layer.className = WATERMARK_CLASS;
  layer.style.position = "absolute";
  layer.style.top = "0";
  layer.style.left = "0";
  layer.style.width = `${page.size.w}px`;
  layer.style.height = `${page.size.h}px`;
  // z-index 0 (not -1) so we stay above the parent page's painted
  // background. Negative z-index on a positioned child paints behind
  // the parent's bg layer, which is why the behindDoc image path
  // already rewrites -1 → 0 in renderPage. Content/text paints above
  // us via document order (the content area is appended after) — that
  // keeps the watermark below text without going below the page bg.
  layer.style.zIndex = "0";
  layer.style.pointerEvents = "none";
  layer.style.overflow = "hidden";
  layer.style.display = "flex";
  layer.style.alignItems = "center";
  layer.style.justifyContent = "center";

  if (watermark.kind === "text") {
    layer.append(renderTextWatermark(watermark, doc));
  } else {
    // Narrowed by the guard above.
    const imageSrc = options.imageSrc;
    if (!imageSrc) {
      return null;
    }
    layer.append(renderPictureWatermark(watermark, imageSrc, doc));
  }
  return layer;
}

function renderTextWatermark(
  watermark: Extract<Watermark, { kind: "text" }>,
  doc: Document,
): HTMLElement {
  const el = doc.createElement("div");
  el.textContent = watermark.text;
  el.style.fontFamily = resolveFontFamily(
    watermark.font ?? "Calibri",
  ).cssFallback;
  // Word's default text-watermark sizing: ~144pt at ~50% opacity. Matches
  // the visual weight of the VML shape's autoscaled WordArt path.
  el.style.fontSize = "144px";
  el.style.fontWeight = "bold";
  el.style.whiteSpace = "nowrap";
  // Word's text watermark uses #C0C0C0 (silver) with semi-transparency
  // (the "washout" preset). `opacity` parses out of the model when the
  // serializer round-trips it from style="opacity:0.5".
  const color = watermark.color ? `#${watermark.color}` : "#C0C0C0";
  el.style.color = color;
  el.style.opacity = String(watermark.opacity ?? 0.5);
  // Word's default "diagonal" orientation is bottom-left → top-right,
  // which is a -45deg rotation in screen space. `diagonal: false` keeps
  // the text horizontal (Word's "Horizontal" preset).
  const rotation = watermark.diagonal === false ? 0 : -45;
  el.style.transform = `rotate(${rotation}deg)`;
  el.style.transformOrigin = "center center";
  return el;
}

function renderPictureWatermark(
  watermark: Extract<Watermark, { kind: "picture" }>,
  imageSrc: string,
  doc: Document,
): HTMLElement {
  const img = doc.createElement("img");
  img.src = imageSrc;
  img.alt = "";
  // Decorative — never announced.
  img.setAttribute("aria-hidden", "true");
  // Scale percent applies to the natural image size. Default to a
  // visible band of the page width when no explicit scale is captured.
  const scalePct = watermark.scale ?? 100;
  img.style.maxWidth = `${scalePct}%`;
  img.style.maxHeight = `${scalePct}%`;
  img.style.opacity = watermark.washout === false ? "1" : "0.4";
  img.style.objectFit = "contain";
  return img;
}
