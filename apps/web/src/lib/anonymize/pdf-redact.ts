import { PDF, rgb, Standard14Font, StandardFonts, white } from "@libpdf/core";

import type {
  NativePipelineEntity,
  NativeStaticRedactionResult,
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

/** Default static replacement for the irreversible "redact" operator.
 * Mirrors the old `DEFAULT_OPERATOR_CONFIG.redactString`, which is no
 * longer part of the public wasm surface. */
const DEFAULT_REDACT_STRING = "[REDACTED]";

const PLACEHOLDER_LABEL = /^\[(?<label>[A-Z][A-Z0-9_]*)_\d+\]$/u;

const parsePlaceholderLabel = (placeholder: string): string | null => {
  const match = PLACEHOLDER_LABEL.exec(placeholder);
  const label = match?.groups?.["label"];
  return label?.toLowerCase().replaceAll("_", " ") ?? null;
};

const redactionLookupKey = (label: string, text: string): string =>
  `${label.toLowerCase()}\0${text}`;

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
  redaction: NativeStaticRedactionResult["redaction"];
};

type BuildPageRedactionsOptions = {
  placeholderByOriginalAndLabel: ReadonlyMap<string, string>;
  redactString: string;
  resolvedEntities: NativePipelineEntity[];
  spans: CharSpan[];
};

const buildPageRedactions = ({
  placeholderByOriginalAndLabel,
  redactString,
  resolvedEntities,
  spans,
}: BuildPageRedactionsOptions): Map<number, PageRedaction[]> => {
  const sorted = resolvedEntities.toSorted((a, b) => a.start - b.start);
  const nonOverlapping: NativePipelineEntity[] = [];
  let lastEnd = 0;
  for (const entity of sorted) {
    if (entity.start >= lastEnd) {
      nonOverlapping.push(entity);
      lastEnd = entity.end;
    }
  }

  const pageRedactions = new Map<number, PageRedaction[]>();
  for (const entity of nonOverlapping) {
    const bboxes = getEntityBBoxes({
      spans,
      entityStart: entity.start,
      entityEnd: entity.end,
    });
    const overlayText =
      placeholderByOriginalAndLabel.get(
        redactionLookupKey(entity.label, entity.text),
      ) ?? redactString;

    for (let index = 0; index < bboxes.length; index++) {
      const bbox = bboxes.at(index);
      if (bbox === undefined) {
        continue;
      }
      const pageRedaction = {
        bbox,
        overlayText: index === 0 ? overlayText : "",
        label: entity.label,
      };
      const existing = pageRedactions.get(bbox.pageIndex);
      if (existing) {
        existing.push(pageRedaction);
      } else {
        pageRedactions.set(bbox.pageIndex, [pageRedaction]);
      }
    }
  }
  return pageRedactions;
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
 *
 * Detection and redaction are a single combined native call now
 * (`pipeline.redactText`), so this function takes the already
 * computed `NativeStaticRedactionResult` instead of a raw entity
 * list + operator config: there is no standalone "redact this
 * entity list" entrypoint anymore. `redactString` only affects the
 * *overlay* text drawn for irreversible ("redact") entities — it
 * must match the string the caller passed to `redactText`'s
 * `operators` argument (or the native default) for the overlay to
 * agree with `redaction.redactedText`.
 *
 * Note: this module has no current caller in the app (PDF
 * redaction/export is not wired up yet); the signature is kept
 * ready for when it is.
 */
export const redactPdf = async (
  pdfBytes: Uint8Array,
  spans: CharSpan[],
  result: NativeStaticRedactionResult,
  redactString = DEFAULT_REDACT_STRING,
): Promise<PdfRedactionResult> => {
  const { resolvedEntities, redaction } = result;

  if (resolvedEntities.length === 0) {
    return { pdfBytes, redaction };
  }

  // `redaction.redactionMap` only contains reversible ("replace")
  // entries (placeholder -> original text), so indexing by both
  // placeholder label and original text recovers the placeholder for
  // every entity that was actually replaced. The composite key keeps
  // same-text entities with different labels distinct.
  const placeholderByOriginalAndLabel = new Map<string, string>();
  for (const [placeholder, original] of redaction.redactionMap) {
    const label = parsePlaceholderLabel(placeholder);
    if (label !== null) {
      placeholderByOriginalAndLabel.set(
        redactionLookupKey(label, original),
        placeholder,
      );
    }
  }

  const pageRedactions = buildPageRedactions({
    placeholderByOriginalAndLabel,
    redactString,
    resolvedEntities,
    spans,
  });

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
          const m = /^\[(?<label>.+?)(?:_(?<suffix>\d+))?\]$/u.exec(
            displayText,
          );
          if (m) {
            const label = m.groups?.["label"] ?? "";
            const suffix = m.groups?.["suffix"] ?? "";
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
                .flatMap((p) =>
                  p.length > 0 ? [(p[0] ?? "").toUpperCase()] : [],
                )
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
