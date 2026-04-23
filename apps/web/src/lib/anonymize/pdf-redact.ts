import { PDF, rgb, Standard14Font, StandardFonts, white } from "@libpdf/core";
import type {
  Entity,
  OperatorConfig,
  RedactionResult,
} from "@stll/anonymize-wasm";

import { getEntityBBoxes } from "@/lib/anonymize/pdf-bbox";
import { neutralisePageText } from "@/lib/anonymize/pdf-content-stream";
import type { CharSpan, PDFBBox } from "@/lib/anonymize/pdf-coords";
import { getEntityPDFColors } from "@/lib/anonymize/ui-constants";

/** Padding around redaction rectangles in points. */
const RECT_PADDING = 2;

/** Minimum font size for placeholder text (points). */
const MIN_PLACEHOLDER_SIZE = 4;

/** Maximum font size for placeholder text (points). */
const MAX_PLACEHOLDER_SIZE = 10;

// ── Types ──────────────────────────────────────────────

/**
 * Region to redact on a specific PDF page.
 */
type PageRedaction = {
  bbox: PDFBBox;
  /** Placeholder text (e.g. "[PERSON_1]"). */
  overlayText: string;
  /** Original entity label for colour coding. */
  label: string;
};

/**
 * Result of PDF anonymisation.
 */
type PdfRedactionResult = {
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
  operatorConfig?: OperatorConfig,
): Promise<PdfRedactionResult> => {
  const {
    buildPlaceholderMap,
    DEFAULT_OPERATOR_CONFIG,
    redactText,
    resolveOperator,
  } = await import("@stll/anonymize-wasm");

  const config = operatorConfig ?? DEFAULT_OPERATOR_CONFIG;

  if (entities.length === 0) {
    return {
      pdfBytes,
      redaction: redactText(pdfText, [], config),
    };
  }

  const redaction = redactText(pdfText, entities, config);

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
    const bboxes = getEntityBBoxes({
      spans,
      entityStart: entity.start,
      entityEnd: entity.end,
    });
    if (bboxes.length === 0) {
      continue;
    }

    const compositeKey = `${entity.label}\0${entity.text}`;
    const placeholder =
      placeholderMap.get(compositeKey) ??
      `[${entity.label.toUpperCase().replace(/\s+/g, "_")}]`;

    // Determine what text to overlay based on operator
    const opType = resolveOperator(config, entity.label);
    const overlayText = opType === "redact" ? config.redactString : placeholder;

    // First bbox gets the text overlay; all get white boxes
    for (let i = 0; i < bboxes.length; i++) {
      const bbox = bboxes[i];
      if (bbox === undefined) {
        continue;
      }
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

      const palette = getEntityPDFColors(entityLabel);
      const colors = {
        fill: rgb(...palette.fill),
        border: rgb(...palette.border),
        text: rgb(...palette.text),
      };

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
          const m = /^\[(.+?)(?:_(\d+))?\]$/.exec(displayText);
          if (m) {
            const label = m[1] ?? "";
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
                .map((p) => (p[0] ?? "").toUpperCase())
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
