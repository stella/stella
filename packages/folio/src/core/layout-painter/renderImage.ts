/**
 * Image Renderer
 *
 * Renders image fragments to DOM. Handles:
 * - Inline images
 * - Anchored/floating images with z-index layering
 * - Basic image sizing
 */

import type {
  ImageFragment,
  ImageBlock,
  ImageMeasure,
} from "../layout-engine/types";
import type { RenderContext } from "./renderUtils";

/**
 * CSS class names for image elements
 */
export const IMAGE_CLASS_NAMES = {
  image: "layout-image",
  imageAnchored: "layout-image-anchored",
};

/**
 * Structural shape required to apply Word's per-image visual attributes
 * (currently `wp:srcRect` crop fractions). `ImageRun` and `ImageBlock` both
 * satisfy this, so callers don't need an adapter.
 *
 * eigenpal #424 (image-crop subset).
 */
export type ImageVisualAttrs = {
  cropTop?: number;
  cropRight?: number;
  cropBottom?: number;
  cropLeft?: number;
};

/**
 * True when any visual attribute is set. Cheap call-site guard so the no-op
 * common case skips the helper call.
 *
 * IMPORTANT: ProseMirror schema attrs default to `null`, not `undefined`,
 * and a `null` survives `as number | undefined` casts in the layout bridge.
 * Use `!= null` rather than `!== undefined` so default-null crop fields are
 * not read as `0`.
 */
export function hasImageVisualAttrs(v: ImageVisualAttrs): boolean {
  return Boolean(v.cropTop || v.cropRight || v.cropBottom || v.cropLeft);
}

/**
 * Apply Word's `<a:srcRect>` crop to an `<img>` whose parent already has
 * `overflow: hidden` and is sized to the *visible* (cropped) dimensions
 * (this matches `wp:extent` semantics: in Word the extent is the cropped
 * frame, with `<a:stretch><a:fillRect/>` stretching the cropped source to
 * fill it).
 *
 * Implementation: scale the `<img>` up so the visible region fills the
 * parent, then shift it by the negative crop offsets so only that region
 * remains in view. A naive `clip-path: inset(...)` is wrong here — it would
 * leave the bitmap rendered at full extent size (so the wrong region shows)
 * and only mask the rest, producing a squished image with blank bands.
 *
 * `fw = 1/(1-left-right)` and `fh = 1/(1-top-bottom)` are the inverse
 * remaining-fractions; multiplying by 100% gives the upscaled width/height
 * so the cropped slice exactly covers the parent.
 *
 * Caller should gate with `hasImageVisualAttrs(v)` to avoid the function
 * call for plain images.
 */
export function applyImageVisualAttrs(
  img: HTMLImageElement,
  v: ImageVisualAttrs,
): void {
  const top = v.cropTop ?? 0;
  const right = v.cropRight ?? 0;
  const bottom = v.cropBottom ?? 0;
  const left = v.cropLeft ?? 0;
  if (!(top || right || bottom || left)) {
    return;
  }
  const remainingW = 1 - left - right;
  const remainingH = 1 - top - bottom;
  // Guard against pathological crops that leave nothing visible; fall back
  // to the original sizing rather than dividing by zero.
  if (remainingW <= 0 || remainingH <= 0) {
    return;
  }
  const fw = 1 / remainingW;
  const fh = 1 / remainingH;
  img.style.width = `${fw * 100}%`;
  img.style.height = `${fh * 100}%`;
  img.style.marginLeft = `${-left * fw * 100}%`;
  img.style.marginTop = `${-top * fh * 100}%`;
  // Object-fit on the upscaled `<img>` would re-letterbox inside the
  // enlarged box; force fill so the bitmap stretches to fw×fh as Word does.
  img.style.objectFit = "fill";
}

/**
 * Create an inline-block `<span>` wrapper sized to the visible (cropped)
 * dimensions with `overflow: hidden`, then size+scale+shift the `<img>`
 * inside it so only the cropped region of the bitmap is visible. See
 * `applyImageVisualAttrs` for the geometry rationale.
 *
 * Use this for inline runs and block images where the painter does not
 * already provide an overflow-clipped container.
 */
export function wrapImageWithCrop(
  img: HTMLImageElement,
  v: ImageVisualAttrs,
  doc: Document,
  outerStyle: {
    display: "inline-block" | "block";
    widthPx: number;
    heightPx: number;
  },
): HTMLElement {
  const wrapper = doc.createElement("span");
  wrapper.style.display = outerStyle.display;
  wrapper.style.overflow = "hidden";
  wrapper.style.width = `${outerStyle.widthPx}px`;
  wrapper.style.height = `${outerStyle.heightPx}px`;
  // The inner `<img>` is scaled relative to the wrapper, so swap its pixel
  // sizing for percentages and let applyImageVisualAttrs do the math.
  img.style.width = "100%";
  img.style.height = "100%";
  applyImageVisualAttrs(img, v);
  wrapper.append(img);
  return wrapper;
}

/**
 * Options for rendering an image fragment
 */
export type RenderImageFragmentOptions = {
  document?: Document;
};

/**
 * Render an image fragment to DOM
 *
 * @param fragment - The image fragment to render
 * @param block - The full image block
 * @param measure - The image measure
 * @param context - Rendering context
 * @param options - Rendering options
 * @returns The image DOM element
 */
export function renderImageFragment(
  fragment: ImageFragment,
  block: ImageBlock,
  _measure: ImageMeasure,
  _context: RenderContext,
  options: RenderImageFragmentOptions = {},
): HTMLElement {
  const doc = options.document ?? document;

  // Create container div
  const containerEl = doc.createElement("div");
  containerEl.className = IMAGE_CLASS_NAMES.image;

  if (fragment.isAnchored) {
    containerEl.classList.add(IMAGE_CLASS_NAMES.imageAnchored);
  }

  // Basic styling
  containerEl.style.position = "absolute";
  containerEl.style.width = `${fragment.width}px`;
  containerEl.style.height = `${fragment.height}px`;
  containerEl.style.overflow = "hidden";

  // Z-index for layering
  if (fragment.zIndex !== undefined) {
    containerEl.style.zIndex = String(fragment.zIndex);
  }

  // Behind document flag
  if (block.anchor?.behindDoc) {
    containerEl.style.zIndex = "-1";
  }

  // Store metadata
  containerEl.dataset["blockId"] = String(fragment.blockId);

  if (fragment.pmStart !== undefined) {
    containerEl.dataset["pmStart"] = String(fragment.pmStart);
  }
  if (fragment.pmEnd !== undefined) {
    containerEl.dataset["pmEnd"] = String(fragment.pmEnd);
  }

  // Create the actual image element
  const imgEl = doc.createElement("img");
  imgEl.src = block.src;
  imgEl.alt = block.alt ?? "";

  // Image sizing
  imgEl.style.width = "100%";
  imgEl.style.height = "100%";
  imgEl.style.objectFit = "contain";
  imgEl.style.display = "block";

  // Apply transform if present (rotation, flip)
  if (block.transform) {
    imgEl.style.transform = block.transform;
  }

  // eigenpal #424: scale/shift `<img>` so the cropped slice fills the
  // overflow-hidden container (already sized to the visible extent above).
  if (hasImageVisualAttrs(block)) {
    applyImageVisualAttrs(imgEl, block);
  }

  // Prevent dragging
  imgEl.draggable = false;

  // Wrap in hyperlink if image has a link
  if (block.hlinkHref) {
    const linkEl = doc.createElement("a");
    linkEl.href = block.hlinkHref;
    linkEl.target = "_blank";
    linkEl.rel = "noopener noreferrer";
    linkEl.style.display = "block";
    linkEl.style.width = "100%";
    linkEl.style.height = "100%";
    linkEl.append(imgEl);
    containerEl.append(linkEl);
  } else {
    containerEl.append(imgEl);
  }

  return containerEl;
}
