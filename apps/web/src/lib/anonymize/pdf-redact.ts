import type { Color } from "@libpdf/core";
import { PDF, rgb, Standard14Font, StandardFonts, white } from "@libpdf/core";

import { DEFAULT_OPERATOR_CONFIG, resolveOperator } from "./operators";
import { neutralisePageText } from "./pdf-content-stream";
import type { CharSpan, PdfBBox } from "./pdf-coords";
import { getEntityBBoxes } from "./pdf-coords";
import { buildPlaceholderMap, redactText } from "./redact";
import type { Entity, OperatorConfig, RedactionResult } from "./types";

/** Padding around redaction rectangles in points. */
const RECT_PADDING = 2;

/** Minimum font size for placeholder text (points). */
const MIN_PLACEHOLDER_SIZE = 4;

/** Maximum font size for placeholder text (points). */
const MAX_PLACEHOLDER_SIZE = 10;

// ── Per-label colour palette ───────────────────────────

/**
 * RGB colours for entity labels, matching the Tailwind
 * `-200` shades used in ENTITY_COLORS (types.ts).
 * Fill = -200 (light bg), border = -400 (medium),
 * text = -700 (dark foreground).
 *
 * Values are [r, g, b] in 0-1 range for @libpdf/core.
 */
type ColorTriple = [number, number, number];
type LabelPalette = {
  fill: ColorTriple;
  border: ColorTriple;
  text: ColorTriple;
};

const LABEL_COLORS: Record<string, LabelPalette> = {
  person: {
    fill: [0.74, 0.83, 0.95], // blue-200
    border: [0.38, 0.56, 0.83], // blue-400
    text: [0.11, 0.29, 0.55], // blue-700
  },
  organization: {
    fill: [0.73, 0.91, 0.78], // green-200
    border: [0.29, 0.73, 0.4], // green-400
    text: [0.08, 0.4, 0.15], // green-700
  },
  "phone number": {
    fill: [0.98, 0.76, 0.83], // pink-200
    border: [0.96, 0.45, 0.58], // pink-400
    text: [0.74, 0.12, 0.24], // pink-700
  },
  address: {
    fill: [0.99, 0.93, 0.7], // yellow-200
    border: [0.98, 0.82, 0.2], // yellow-400
    text: [0.63, 0.49, 0.04], // yellow-700
  },
  "email address": {
    fill: [0.99, 0.84, 0.69], // orange-200
    border: [0.98, 0.58, 0.24], // orange-400
    text: [0.77, 0.33, 0.01], // orange-700
  },
  "date of birth": {
    fill: [0.91, 0.8, 0.94], // purple-200
    border: [0.75, 0.52, 0.81], // purple-400
    text: [0.43, 0.18, 0.52], // purple-700
  },
  "bank account number": {
    fill: [0.99, 0.79, 0.79], // red-200
    border: [0.97, 0.45, 0.45], // red-400
    text: [0.72, 0.11, 0.11], // red-700
  },
  iban: {
    fill: [0.99, 0.79, 0.79],
    border: [0.97, 0.45, 0.45],
    text: [0.72, 0.11, 0.11],
  },
  "tax identification number": {
    fill: [0.6, 0.92, 0.9], // teal-200
    border: [0.18, 0.71, 0.67], // teal-400
    text: [0.05, 0.37, 0.35], // teal-700
  },
  "identity card number": {
    fill: [0.78, 0.78, 0.97], // indigo-200
    border: [0.5, 0.5, 0.91], // indigo-400
    text: [0.23, 0.23, 0.6], // indigo-700
  },
  "registration number": {
    fill: [0.65, 0.93, 0.97], // cyan-200
    border: [0.13, 0.78, 0.85], // cyan-400
    text: [0.06, 0.41, 0.45], // cyan-700
  },
  "credit card number": {
    fill: [1, 0.79, 0.82], // rose-200
    border: [0.98, 0.44, 0.52], // rose-400
    text: [0.74, 0.12, 0.21], // rose-700
  },
  "passport number": {
    fill: [0.87, 0.82, 0.95], // violet-200
    border: [0.66, 0.55, 0.87], // violet-400
    text: [0.36, 0.25, 0.6], // violet-700
  },
  "czech birth number": {
    fill: [0.98, 0.76, 0.83],
    border: [0.96, 0.45, 0.58],
    text: [0.74, 0.12, 0.24],
  },
  date: {
    fill: [0.99, 0.93, 0.7],
    border: [0.98, 0.82, 0.2],
    text: [0.63, 0.49, 0.04],
  },
};

/** Fallback palette for unknown labels; neutral gray. */
const FALLBACK_PALETTE: LabelPalette = {
  fill: [0.9, 0.9, 0.9],
  border: [0.63, 0.63, 0.63],
  text: [0.25, 0.25, 0.25],
};

/**
 * Get fill, border, and text colours for a placeholder
 * like `[PERSON_1]`. Looks up the label in LABEL_COLORS
 * (matching the Tailwind classes in ENTITY_COLORS).
 */
const getEntityColors = (
  placeholder: string,
): { fill: Color; border: Color; text: Color } => {
  const match = placeholder.match(/^\[(.+?)(?:_(\d+))?\]$/);
  const rawLabel = match?.[1]?.toLowerCase() ?? "";
  const canonical = rawLabel.replace(/_/g, " ");

  const palette = LABEL_COLORS[canonical] ?? FALLBACK_PALETTE;

  return {
    fill: rgb(...palette.fill),
    border: rgb(...palette.border),
    text: rgb(...palette.text),
  };
};

// ── Types ──────────────────────────────────────────────

/**
 * Region to redact on a specific PDF page.
 */
type PageRedaction = {
  bbox: PdfBBox;
  /** Placeholder text (e.g. "[PERSON_1]"). */
  overlayText: string;
  /** Original entity label for colour coding. */
  label: string;
};

/**
 * Result of PDF anonymisation.
 */
export type PdfRedactionResult = {
  /** The anonymised PDF as bytes, ready for download. */
  pdfBytes: Uint8Array;
  /** The text-level redaction result (map, operators, etc.). */
  redaction: RedactionResult;
};

// ── Main ───────────────────────────────────────────────

/**
 * Anonymise a PDF by drawing white rectangles over detected
 * entities and overlaying placeholder text. The original text
 * underneath is covered visually.
 *
 * The output PDF preserves page geometry exactly: same page
 * count, same dimensions, same coordinates for all non-
 * redacted content. This makes AI-generated bounding boxes
 * on the anonymised PDF valid for the original too.
 */
export const redactPdf = async (
  pdfBytes: Uint8Array,
  pdfText: string,
  spans: CharSpan[],
  entities: Entity[],
  operatorConfig: OperatorConfig = DEFAULT_OPERATOR_CONFIG,
): Promise<PdfRedactionResult> => {
  if (entities.length === 0) {
    return {
      pdfBytes,
      redaction: redactText(pdfText, [], operatorConfig),
    };
  }

  const redaction = redactText(pdfText, entities, operatorConfig);

  // Build the same placeholder map that redactText uses
  // internally, keyed by "${label}\0${text}"
  const placeholderMap = buildPlaceholderMap(entities);

  // Sort and de-overlap (same logic as redactText)
  const sorted = entities.toSorted((a, b) => a.start - b.start);
  const nonOverlapping: Entity[] = [];
  let lastEnd = 0;
  for (const entity of sorted) {
    if (entity.start >= lastEnd) {
      nonOverlapping.push(entity);
      lastEnd = entity.end;
    }
  }

  // Build per-page redaction regions
  const pageRedactions = new Map<number, PageRedaction[]>();

  for (const entity of nonOverlapping) {
    const bboxes = getEntityBBoxes(spans, entity.start, entity.end);
    if (bboxes.length === 0) {
      continue;
    }

    const compositeKey = `${entity.label}\0${entity.text}`;
    const placeholder =
      placeholderMap.get(compositeKey) ??
      `[${entity.label.toUpperCase().replace(/\s+/g, "_")}]`;

    // Determine what text to overlay based on operator
    const opType = resolveOperator(operatorConfig, entity.label);
    const overlayText =
      opType === "redact" ? operatorConfig.redactString : placeholder;

    // First bbox gets the text overlay; all get white boxes
    for (let i = 0; i < bboxes.length; i++) {
      const bbox = bboxes[i];
      const list = pageRedactions.get(bbox.pageIndex) ?? [];
      list.push({
        bbox,
        overlayText: i === 0 ? overlayText : "",
        label: entity.label,
      });
      pageRedactions.set(bbox.pageIndex, list);
    }
  }

  // Load PDF with @libpdf/core and draw overlays
  const pdfDoc = await PDF.load(pdfBytes);
  const pages = pdfDoc.getPages();
  const helvetica = Standard14Font.of(StandardFonts.Helvetica);

  for (const [pageIdx, redactions] of pageRedactions) {
    const page = pages.at(pageIdx);
    if (page === undefined) {
      continue;
    }

    // Collect redaction boxes for content stream
    // neutralisation
    const redactionBoxes = redactions.map(({ bbox }) => ({
      x: bbox.x - RECT_PADDING,
      y: bbox.y - RECT_PADDING,
      width: bbox.width + RECT_PADDING * 2,
      height: bbox.height + RECT_PADDING * 2,
    }));

    // Phase 3: Neutralise original text in content stream
    // so copy-paste yields spaces, not original PII
    neutralisePageText(pdfDoc.context, page.dict, redactionBoxes);

    // Phase 4: Remove annotations (links, comments, etc.)
    // whose bounding boxes intersect any redaction zone.
    // Without this, mailto:/http: links remain clickable
    // under the white overlay — a critical PII leak vector.
    const annotations = page.getAnnotations();
    for (const annot of annotations) {
      const rect = annot.rect;
      const annotBox = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
      const overlaps = redactionBoxes.some(
        (rbox) =>
          annotBox.x < rbox.x + rbox.width &&
          annotBox.x + annotBox.width > rbox.x &&
          annotBox.y < rbox.y + rbox.height &&
          annotBox.y + annotBox.height > rbox.y,
      );
      if (overlaps) {
        page.removeAnnotation(annot);
      }
    }

    // Phase 5: Draw redaction overlays
    for (const { bbox, overlayText, label: entityLabel } of redactions) {
      const rx = bbox.x - RECT_PADDING;
      const ry = bbox.y - RECT_PADDING;
      const rw = bbox.width + RECT_PADDING * 2;
      const rh = bbox.height + RECT_PADDING * 2;

      // Always derive the colour key from the entity label,
      // not from overlayText (which may be the redact string
      // "█████" and wouldn't match the [LABEL_N] pattern).
      const colorKey = `[${entityLabel.toUpperCase().replace(/\s+/g, "_")}]`;
      const colors = getEntityColors(colorKey);

      // White underlay hides original text (security)
      page.drawRectangle({
        x: rx,
        y: ry,
        width: rw,
        height: rh,
        color: white,
      });

      // Coloured box with dotted border
      page.drawRectangle({
        x: rx,
        y: ry,
        width: rw,
        height: rh,
        color: colors.fill,
        borderColor: colors.border,
        borderWidth: 0.5,
      });

      // Draw overlay text, scaled to fit inside the box.
      // If it still doesn't fit at MIN size, abbreviate
      // (e.g. [PERSON_1] → [PER_1] → [P1]) so text never
      // leaks outside the box.
      if (overlayText.length > 0) {
        const innerWidth = rw - 2; // 1pt inset each side
        let size = Math.min(bbox.fontSize, MAX_PLACEHOLDER_SIZE);
        let displayText = overlayText;

        const fitsAtSize = (text: string, s: number): boolean =>
          helvetica.widthOfTextAtSize(text, s) <= innerWidth;

        // Shrink font until the text fits the box width
        const textWidth = helvetica.widthOfTextAtSize(displayText, size);
        if (textWidth > innerWidth && innerWidth > 0) {
          size = Math.max(
            MIN_PLACEHOLDER_SIZE,
            size * (innerWidth / textWidth),
          );
        }

        // If still too wide at MIN size, abbreviate
        if (!fitsAtSize(displayText, size)) {
          // [CZECH_BIRTH_NUMBER_1] → [CZE_B_N_1]
          const m = displayText.match(/^\[(.+?)(?:_(\d+))?\]$/);
          if (m) {
            const label = m[1];
            const suffix = m[2] ?? "";
            const parts = label.split("_");

            // Try 3-letter abbreviation: [PER_1]
            const abbrev3 = parts
              .map((p) => p.slice(0, 3).toUpperCase())
              .join("_");
            const short3 = suffix ? `[${abbrev3}_${suffix}]` : `[${abbrev3}]`;

            if (fitsAtSize(short3, size)) {
              displayText = short3;
            } else {
              // Try initials: [P1] or [CBN1]
              const initials = parts
                .filter((p) => p.length > 0)
                .map((p) => p[0].toUpperCase())
                .join("");
              const shortInit = `[${initials}${suffix}]`;

              if (fitsAtSize(shortInit, size)) {
                displayText = shortInit;
              } else {
                // Last resort: just the suffix number
                displayText = suffix ? `[${suffix}]` : "";
              }
            }
          }
        }

        if (displayText.length > 0) {
          // Center vertically within the box
          const textY = ry + (rh - size) / 2;

          page.drawText(displayText, {
            x: rx + 1,
            y: textY,
            size,
            font: StandardFonts.Helvetica,
            color: colors.text,
          });
        }
      }
    }
  }

  const outputBytes = await pdfDoc.save();

  return { pdfBytes: outputBytes, redaction };
};
