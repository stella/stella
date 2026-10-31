/**
 * A matter document's PDF with the reader's marks written in as standard
 * text markup annotations, for the copy a download hands over.
 *
 * What is written depends on the export mode, decided here and nowhere else:
 * `highlights` writes highlights by style, colour and position only, with no
 * comment text, no author names and no comment-only marks;
 * `highlightsWithComments` adds comments, their words and author names.
 *
 * Each mark is placed with `placeMark`, the rule the web viewer draws it by,
 * on the page text LibPDF extracts, so the copy carries exactly the marks
 * the viewer shows on this file and at the same glyphs. The annotations are
 * appended as one incremental update: the stored bytes are a byte-for-byte
 * prefix of the copy, so a signature keeps covering its revision.
 *
 * Anything that cannot take the annotations without harm keeps the stored
 * bytes unchanged: a certification whose permission forbids annotations
 * (ISO 32000-1 12.8.2.2, P = 1 or 2), an encrypted file, a file LibPDF
 * cannot read or can only rewrite. The download never fails over its marks.
 */

import { PDF, PdfDict, rgb } from "@libpdf/core";
import type {
  Color,
  PdfArray,
  PdfObject,
  PDFPage,
  PdfRef,
  TextMarkupAnnotationOptions,
} from "@libpdf/core";
import { panic, Result, TaggedError } from "better-result";

import type {
  ReaderAnnotationColor,
  ReaderAnnotationKind,
  ReaderAnnotationStyle,
} from "@stll/api-contract/legal-reader-annotations";
import type { MarkedPdfExportMode } from "@stll/api-contract/marked-pdf-export";
import {
  placeMark,
  readPdfPageGlyphText,
} from "@stll/api-contract/pdf-mark-placement";
import type {
  MarkAnchor,
  MarkPageText,
} from "@stll/api-contract/pdf-mark-placement";

import { pdfPageTextSha256 } from "@/api/lib/files/pdf-page-text";
import {
  appendAnnotationRevision,
  PdfRevisionAppendError,
} from "@/api/lib/files/pdf-signatures";
import { readDocMdpPermission } from "@/api/lib/files/pdf-signing/doc-mdp";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

class MarkedPdfWriteError extends TaggedError("MarkedPdfWriteError")<{
  message: string;
  cause: unknown;
}> {}

const MARKED_PDF_FAILURE = failureSink({
  event: "files.marked_pdf.failed",
  expected: [],
});

/** One row of a mark, as the caller may see it. */
export type PdfMark = MarkAnchor & {
  kind: ReaderAnnotationKind;
  color: ReaderAnnotationColor | null;
  style: ReaderAnnotationStyle | null;
  /** The note; a comment's words, on the first row of its group. */
  body: string | null;
  /** Shown beside the mark in the viewer, so already the reader's to see. */
  authorName: string;
};

/** Why the copy is the stored bytes as they are. */
export const MARKED_PDF_UNCHANGED = {
  noMarks: "no-marks",
  certified: "certified-without-annotations",
  cannotAppend: "cannot-append",
  unreadable: "unreadable",
} as const;
export type MarkedPdfUnchangedReason =
  (typeof MARKED_PDF_UNCHANGED)[keyof typeof MARKED_PDF_UNCHANGED];

export type MarkedPdf =
  | { status: "marked"; bytes: Uint8Array; annotationCount: number }
  | { status: "unchanged"; reason: MarkedPdfUnchangedReason };

/**
 * The highlighter colour each swatch is written as. A swatch's on-screen
 * colour is a theme token that changes with the theme; a PDF annotation needs
 * one sRGB colour that reads on white paper under a multiply blend.
 */
const MARK_SRGB = {
  yellow: [1, 0.85, 0.2],
  green: [0.49, 0.85, 0.4],
  sky: [0.4, 0.75, 0.95],
  violet: [0.74, 0.6, 0.95],
  red: [0.95, 0.42, 0.42],
} as const satisfies Record<
  ReaderAnnotationColor,
  readonly [red: number, green: number, blue: number]
>;

/** A stored swatch as the colour of its PDF annotation. */
export const pdfMarkColor = (color: ReaderAnnotationColor): Color => {
  const [red, green, blue] = MARK_SRGB[color];
  return rgb(red, green, blue);
};

/** The viewer draws a comment as a sky underline beneath its passage. */
const COMMENT_COLOR = "sky" satisfies ReaderAnnotationColor;

type MarkupSubtype = "Highlight" | "Underline" | "Squiggly" | "StrikeOut";

const STYLE_SUBTYPE = {
  highlight: "Highlight",
  underline: "Underline",
  squiggly: "Squiggly",
  strikethrough: "StrikeOut",
} as const satisfies Record<ReaderAnnotationStyle, MarkupSubtype>;

const addMarkup = (
  page: PDFPage,
  subtype: MarkupSubtype,
  options: TextMarkupAnnotationOptions,
): void => {
  switch (subtype) {
    case "Highlight": {
      page.addHighlightAnnotation(options);
      return;
    }
    case "Underline": {
      page.addUnderlineAnnotation(options);
      return;
    }
    case "Squiggly": {
      page.addSquigglyAnnotation(options);
      return;
    }
    case "StrikeOut": {
      page.addStrikeOutAnnotation(options);
      return;
    }
    default: {
      subtype satisfies never;
      panic(`Unhandled markup subtype: ${String(subtype)}`);
    }
  }
};

/** What one mark is written as: its subtype, colour and words. */
type MarkAnnotation = {
  subtype: MarkupSubtype;
  color: ReaderAnnotationColor;
  contents: string;
  title: string;
};

/** A mark as the viewer draws it: its subtype and colour. */
const markLook = (mark: PdfMark): Pick<MarkAnnotation, "color" | "subtype"> =>
  mark.kind === "highlight" && mark.color !== null && mark.style !== null
    ? { subtype: STYLE_SUBTYPE[mark.style], color: mark.color }
    : { subtype: "Underline", color: COMMENT_COLOR };

/**
 * What a mark is written as in each export mode, or null when the mode
 * leaves it out. The plain copy carries which passages were highlighted and
 * nothing else: a comment, and any author or note, stays inside the firm.
 */
const MARK_ANNOTATION_BY_MODE = {
  highlights: (mark) =>
    mark.kind === "highlight"
      ? { ...markLook(mark), contents: "", title: "" }
      : null,
  highlightsWithComments: (mark) => ({
    ...markLook(mark),
    contents: mark.body ?? "",
    title: mark.authorName.trim(),
  }),
} as const satisfies Record<
  MarkedPdfExportMode,
  (mark: PdfMark) => MarkAnnotation | null
>;

/** Field trees deeper than this are malformed; the walk stops there. */
const MAX_FIELD_DEPTH = 32;

/** The `P` of a FieldMDP transform in a signature's `/Reference`, if any. */
const fieldMdpTransformPermission = (
  signature: PdfDict | undefined,
  resolve: (ref: PdfRef) => PdfObject | null,
): number | undefined => {
  const references = signature?.getArray("Reference", resolve);
  for (let index = 0; index < (references?.length ?? 0); index += 1) {
    const reference = references?.at(index, resolve);
    const permission =
      reference instanceof PdfDict &&
      reference.getName("TransformMethod", resolve)?.value === "FieldMDP"
        ? reference.getDict("TransformParams", resolve)?.getNumber("P", resolve)
            ?.value
        : undefined;
    if (permission !== undefined) {
      return permission;
    }
  }
  return undefined;
};

/**
 * The strictest modification permission a signed field's lock grants, on the
 * same scale as DocMDP's (ISO 32000-2: `P` in the field's `/Lock` dictionary,
 * Table 236, and in the FieldMDP transform its signature carries, Table
 * 257); null when no signed field carries one. The field tree is read from
 * the catalog itself, so a lock set only in `/Lock` is seen too; a field is
 * signed when it, or a parent it inherits from, has a `/V`.
 */
const fieldLockPermission = (pdf: PDF): number | null => {
  const resolve = (ref: PdfRef): PdfObject | null => pdf.getObject(ref);
  let strictest: number | null = null;
  const consider = (permission: number | undefined) => {
    if (permission !== undefined) {
      strictest =
        strictest === null ? permission : Math.min(strictest, permission);
    }
  };
  const visit = (
    fields: PdfArray | undefined,
    inheritedValue: PdfDict | undefined,
    depth: number,
  ): void => {
    if (depth > MAX_FIELD_DEPTH) {
      return;
    }
    for (let index = 0; index < (fields?.length ?? 0); index += 1) {
      const field = fields?.at(index, resolve);
      if (!(field instanceof PdfDict)) {
        continue;
      }
      const value = field.getDict("V", resolve) ?? inheritedValue;
      if (value !== undefined) {
        consider(
          field.getDict("Lock", resolve)?.getNumber("P", resolve)?.value,
        );
        consider(fieldMdpTransformPermission(value, resolve));
      }
      visit(field.getArray("Kids", resolve), value, depth + 1);
    }
  };
  visit(
    pdf.getCatalog().getDict("AcroForm", resolve)?.getArray("Fields", resolve),
    undefined,
    0,
  );
  return strictest;
};

/** The annotation permission level; anything below it forbids annotations. */
const ANNOTATIONS_ALLOWED = 3;

/**
 * Whether a signature in the file forbids adding annotations: a
 * certification at P = 1 or 2, or a field lock at either.
 */
const signaturesForbidAnnotations = (pdf: PDF, source: Uint8Array) => {
  const certification = readDocMdpPermission({ pdf, source });
  const lock = fieldLockPermission(pdf);
  return (
    (certification !== null && certification < ANNOTATIONS_ALLOWED) ||
    (lock !== null && lock < ANNOTATIONS_ALLOWED)
  );
};

type WriteMarksOptions = {
  /** The marks the caller may see on this document, in any order. */
  marks: readonly PdfMark[];
  /** What of the marks the copy carries. */
  mode: MarkedPdfExportMode;
  /** The stored PDF bytes; never modified. */
  source: Uint8Array;
  /** The file being downloaded, which `placeMark` places marks for. */
  viewedFieldId: string;
};

/** The page texts the marks need, read once per page. */
const readMarkPages = (
  pdf: PDF,
  pageNumbers: ReadonlySet<number>,
): Map<number, { page: PDFPage; text: MarkPageText }> => {
  const pages = pdf.getPages();
  const read = new Map<number, { page: PDFPage; text: MarkPageText }>();
  for (const pageNumber of pageNumbers) {
    const page = pages.at(pageNumber - 1);
    if (pageNumber < 1 || page === undefined) {
      continue;
    }
    const glyphText = readPdfPageGlyphText(page.extractText());
    read.set(pageNumber, {
      page,
      text: { ...glyphText, sha256: pdfPageTextSha256(glyphText.text) },
    });
  }
  return read;
};

/**
 * The stored PDF with every placeable mark appended as a text markup
 * annotation, or why it stays as stored.
 */
export const writeMarksIntoPdf = async ({
  marks,
  mode,
  source,
  viewedFieldId,
}: WriteMarksOptions): Promise<MarkedPdf> => {
  const marked = await Result.tryPromise({
    try: async (): Promise<Result<MarkedPdf, PdfRevisionAppendError>> => {
      const annotationFor = MARK_ANNOTATION_BY_MODE[mode];
      const written = marks.flatMap((mark) => {
        const annotation = annotationFor(mark);
        return annotation === null ? [] : [{ mark, annotation }];
      });
      if (written.length === 0) {
        return Result.ok({
          status: "unchanged",
          reason: MARKED_PDF_UNCHANGED.noMarks,
        });
      }
      const pdf = await PDF.load(source);
      if (pdf.isEncrypted || pdf.canSaveIncrementally() !== null) {
        return Result.ok({
          status: "unchanged",
          reason: MARKED_PDF_UNCHANGED.cannotAppend,
        });
      }
      if (signaturesForbidAnnotations(pdf, source)) {
        return Result.ok({
          status: "unchanged",
          reason: MARKED_PDF_UNCHANGED.certified,
        });
      }

      const pages = readMarkPages(
        pdf,
        new Set(written.map(({ mark }) => mark.pageNumber)),
      );
      let annotationCount = 0;
      for (const { mark, annotation } of written) {
        const read = pages.get(mark.pageNumber);
        const placement = placeMark({
          anchor: mark,
          page: read?.text,
          pagesRead: true,
          viewedFieldId,
        });
        if (read === undefined || placement.type !== "placed") {
          continue;
        }
        const { color, contents, subtype, title } = annotation;
        addMarkup(read.page, subtype, {
          rects: placement.boxes,
          color: pdfMarkColor(color),
          ...(contents.length > 0 && { contents }),
          ...(title.length > 0 && { title }),
        });
        annotationCount += 1;
      }
      if (annotationCount === 0) {
        return Result.ok({
          status: "unchanged",
          reason: MARKED_PDF_UNCHANGED.noMarks,
        });
      }

      const appended = await appendAnnotationRevision(pdf);
      return appended.map((bytes) => ({
        status: "marked",
        bytes,
        annotationCount,
      }));
    },
    catch: (cause) =>
      new MarkedPdfWriteError({
        message: "Could not prepare marked PDF",
        cause,
      }),
  });
  const result = marked.andThen((value) => value);
  if (result.isOk()) {
    return result.value;
  }
  observeFailure(result.error, {
    sink: MARKED_PDF_FAILURE,
    ctx: { mode },
  });
  return {
    status: "unchanged",
    reason: PdfRevisionAppendError.is(result.error)
      ? MARKED_PDF_UNCHANGED.cannotAppend
      : MARKED_PDF_UNCHANGED.unreadable,
  };
};
