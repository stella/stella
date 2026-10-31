import {
  PDF,
  PdfDict,
  PdfName,
  PdfNumber,
  rectsToQuadPoints,
} from "@libpdf/core";
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { READER_ANNOTATION_STYLES } from "@stll/api-contract/legal-reader-annotations";
import type { ReaderAnnotationStyle } from "@stll/api-contract/legal-reader-annotations";
import { MARKED_PDF_EXPORT_MODES } from "@stll/api-contract/marked-pdf-export";
import type { MarkedPdfExportMode } from "@stll/api-contract/marked-pdf-export";
import {
  mergePdfTextBoxes,
  readPdfPageGlyphText,
} from "@stll/api-contract/pdf-mark-placement";

import {
  MARKED_PDF_UNCHANGED,
  pdfMarkColor,
  writeMarksIntoPdf,
} from "@/api/lib/files/marked-pdf";
import type {
  MarkedPdfUnchangedReason,
  PdfMark,
} from "@/api/lib/files/marked-pdf";
import { pdfPageTextSha256 } from "@/api/lib/files/pdf-page-text";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import {
  createEncryptedPdf,
  createSignedPdf,
  readSignatureIntegrity,
} from "@/api/tests/helpers/signed-pdf";
import { createTestRsaKeyPool } from "@/api/tests/helpers/test-pki";

const keyPool = createTestRsaKeyPool();
beforeEach(() => keyPool.reset());

const FIELD = "field-of-this-version";
const OTHER_FIELD = "field-of-another-version";
const LINE_ONE = "The seller shall deliver the goods";
const LINE_TWO = "within thirty days of the order.";

/** A two-page PDF with real text on its first page, as an upload would be. */
const createTextPdf = async (): Promise<Uint8Array> => {
  const pdf = PDF.create();
  const page = pdf.addPage({ width: 600, height: 800 });
  page.drawText(LINE_ONE, { x: 50, y: 700, size: 14 });
  page.drawText(LINE_TWO, { x: 50, y: 680, size: 14 });
  pdf.addPage({ width: 600, height: 800 });
  return await pdf.save();
};

/** Page one's text and glyph boxes, read the way the viewer reads them. */
const readPageOne = async (bytes: Uint8Array) => {
  const page = (await PDF.load(bytes)).getPages().at(0);
  if (page === undefined) {
    throw new Error("the fixture has no first page");
  }
  return readPdfPageGlyphText(page.extractText());
};

/** A mark over `quote` on page one, anchored to the page as it reads. */
const markOn = async (
  bytes: Uint8Array,
  quote: string,
  overrides: Partial<PdfMark> = {},
): Promise<PdfMark> => {
  const page = await readPageOne(bytes);
  const startOffset = page.text.indexOf(quote);
  expect(startOffset).toBeGreaterThanOrEqual(0);
  return {
    authorName: "Alex Author",
    body: null,
    color: "yellow",
    endOffset: startOffset + quote.length,
    fieldId: FIELD,
    kind: "highlight",
    pageNumber: 1,
    pageTextSha256: pdfPageTextSha256(page.text),
    quote,
    startOffset,
    style: "highlight",
    ...overrides,
  };
};

/** The glyph boxes the viewer draws a mark over, as PDF QuadPoints. */
const expectedQuads = async (bytes: Uint8Array, mark: PdfMark) => {
  const page = await readPageOne(bytes);
  const boxes = page.boxesByOffset
    .slice(mark.startOffset, mark.endOffset)
    .filter((box) => box !== null);
  return rectsToQuadPoints(mergePdfTextBoxes(boxes));
};

/** QuadPoints as read back: LibPDF writes numbers to five decimals. */
const expectSameQuads = (
  actual: readonly (readonly number[])[],
  expected: readonly (readonly number[])[],
) => {
  expect(actual.map((quad) => quad.length)).toEqual(
    expected.map((quad) => quad.length),
  );
  for (const [quadIndex, quad] of expected.entries()) {
    for (const [index, value] of quad.entries()) {
      expect(actual[quadIndex]?.[index] ?? Number.NaN).toBeCloseTo(value, 4);
    }
  }
};

const isPrefix = (prefix: Uint8Array, bytes: Uint8Array) =>
  bytes.length > prefix.length &&
  Buffer.from(bytes.subarray(0, prefix.length)).equals(Buffer.from(prefix));

/** Most cases read the full copy; the plain Download's cases name theirs. */
const write = async (
  source: Uint8Array,
  marks: readonly PdfMark[],
  mode: MarkedPdfExportMode = "highlightsWithComments",
) =>
  await writeMarksIntoPdf({
    // A copy, so a write into the caller's bytes would show as a difference.
    source: source.slice(),
    marks,
    mode,
    viewedFieldId: FIELD,
  });

const markedBytes = async (
  source: Uint8Array,
  marks: readonly PdfMark[],
  mode: MarkedPdfExportMode = "highlightsWithComments",
) => {
  const marked = await write(source, marks, mode);
  if (marked.status !== "marked") {
    throw new Error(`expected a marked copy, got ${marked.reason}`);
  }
  return marked;
};

const pageOneAnnotations = async (bytes: Uint8Array) =>
  (await PDF.load(bytes)).getPages().at(0)?.getAnnotations() ?? [];

describe("a downloaded PDF with the reader's marks", () => {
  test.each(["extraction", "incremental save"] as const)(
    "keeps stored bytes and records a failed %s",
    async (stage) => {
      const source = await createTextPdf();
      const stored = source.slice();
      const mark = await markOn(source, "seller");
      const pdf = await PDF.load(source);
      const pages = pdf.getPages();
      const page = pages.at(0);
      if (page === undefined) {
        throw new Error("the fixture has no first page");
      }
      spyOn(pdf, "getPages").mockReturnValue(pages);
      const failure = new Error("PDF marking fixture failure");
      const fault =
        stage === "extraction"
          ? spyOn(page, "extractText").mockImplementation(() => {
              throw failure;
            })
          : spyOn(pdf, "save").mockRejectedValue(failure);
      spyOn(PDF, "load").mockResolvedValue(pdf);
      const analytics = installRecordingAnalytics();
      const logs = installRecordingLogger();
      try {
        const marked = await writeMarksIntoPdf({
          source,
          marks: [mark],
          mode: "highlights",
          viewedFieldId: FIELD,
        });
        expect(fault).toHaveBeenCalledTimes(1);
        expect(marked.status).toBe("unchanged");
        const downloaded = marked.status === "marked" ? marked.bytes : source;
        expect(downloaded).toEqual(stored);
        expect(source).toEqual(stored);
        expect(analytics.exceptions()).toHaveLength(1);
        expect(
          logs.records.some(
            ({ message }) => message === "files.marked_pdf.failed",
          ),
        ).toBe(true);
      } finally {
        mock.restore();
        logs.restore();
        analytics.restore();
      }
    },
  );

  test("carries a highlight as a /Highlight annotation over its words", async () => {
    const source = await createTextPdf();
    const mark = await markOn(source, "deliver the goods");

    const marked = await markedBytes(source, [mark]);

    expect(marked.annotationCount).toBe(1);
    // An incremental update: the upload is a byte-for-byte prefix.
    expect(isPrefix(source, marked.bytes)).toBe(true);
    const [annotation] = await pageOneAnnotations(marked.bytes);
    expect(annotation?.type).toBe("Highlight");
    expect(annotation?.contents).toBe(null);
    expect(annotation?.color).toEqual(pdfMarkColor("yellow"));
    const highlights =
      (await PDF.load(marked.bytes))
        .getPages()
        .at(0)
        ?.getHighlightAnnotations() ?? [];
    expect(highlights).toHaveLength(1);
    expect(highlights[0]?.title).toBe("Alex Author");
    expectSameQuads(
      highlights[0]?.quadPoints ?? [],
      await expectedQuads(source, mark),
    );
  });

  test("keeps a quad per line for a mark across a line break", async () => {
    const source = await createTextPdf();
    const mark = await markOn(source, "the goods\nwithin thirty");

    const marked = await markedBytes(source, [mark]);

    const [highlight] =
      (await PDF.load(marked.bytes))
        .getPages()
        .at(0)
        ?.getHighlightAnnotations() ?? [];
    const quads = highlight?.quadPoints ?? [];
    expect(quads).toHaveLength(2);
    expectSameQuads(quads, await expectedQuads(source, mark));
    // The first line sits above the second in PDF space (y grows upward).
    expect(quads[0]?.[1] ?? 0).toBeGreaterThan(quads[1]?.[1] ?? 0);
  });

  test("writes each highlight style as its text markup subtype", async () => {
    const source = await createTextPdf();
    const subtypes = {
      highlight: "Highlight",
      underline: "Underline",
      squiggly: "Squiggly",
      strikethrough: "StrikeOut",
    } as const satisfies Record<ReaderAnnotationStyle, string>;
    const marks = await Promise.all(
      READER_ANNOTATION_STYLES.map(
        async (style) =>
          await markOn(source, "seller", { style, color: "green" }),
      ),
    );

    const marked = await markedBytes(source, marks);

    const annotations = await pageOneAnnotations(marked.bytes);
    expect(annotations.map((annotation) => annotation.type)).toEqual(
      READER_ANNOTATION_STYLES.map((style) => subtypes[style]),
    );
    for (const annotation of annotations) {
      expect(annotation.color).toEqual(pdfMarkColor("green"));
    }
  });

  test("carries a comment's words as the annotation's /Contents", async () => {
    const source = await createTextPdf();
    const comment = await markOn(source, "thirty days", {
      kind: "comment",
      color: null,
      style: null,
      body: "Check against clause 7.",
    });

    const marked = await markedBytes(source, [comment]);

    const [annotation] = await pageOneAnnotations(marked.bytes);
    expect(annotation?.type).toBe("Underline");
    expect(annotation?.contents).toBe("Check against clause 7.");
    expect(annotation?.color).toEqual(pdfMarkColor("sky"));
  });

  test("writes a mark from another version only where its page reads the same", async () => {
    const source = await createTextPdf();
    const sameText = await markOn(source, "seller", { fieldId: OTHER_FIELD });
    const otherText = await markOn(source, "goods", {
      fieldId: OTHER_FIELD,
      pageTextSha256: pdfPageTextSha256("a page that read differently"),
    });
    // The viewer lists a mark whose words are gone beside the pages; the copy
    // cannot list it anywhere, so it is left out, never drawn elsewhere.
    expect(await write(source, [otherText])).toEqual({
      status: "unchanged",
      reason: MARKED_PDF_UNCHANGED.noMarks,
    });

    const marked = await markedBytes(source, [sameText, otherText]);

    expect(marked.annotationCount).toBe(1);
    expect(
      (await pageOneAnnotations(marked.bytes)).map(
        (annotation) => annotation.rect.x,
      ),
    ).toHaveLength(1);
  });

  test("hands over the stored bytes when there is nothing to write or it cannot be read", async () => {
    expect(await write(await createTextPdf(), [])).toEqual({
      status: "unchanged",
      reason: MARKED_PDF_UNCHANGED.noMarks,
    });
    const mark = await markOn(await createTextPdf(), "seller");
    // LibPDF may refuse the bytes outright or recover them into a document
    // it can only rewrite; either way nothing is appended to them.
    const garbled = await write(new TextEncoder().encode("not a pdf"), [mark]);
    if (garbled.status !== "unchanged") {
      throw new Error("garbled bytes were given annotations");
    }
    const handedOver: readonly MarkedPdfUnchangedReason[] = [
      MARKED_PDF_UNCHANGED.unreadable,
      MARKED_PDF_UNCHANGED.cannotAppend,
      MARKED_PDF_UNCHANGED.noMarks,
    ];
    expect(handedOver).toContain(garbled.reason);
    expect(await write(await createEncryptedPdf(), [mark])).toEqual({
      status: "unchanged",
      reason: MARKED_PDF_UNCHANGED.cannotAppend,
    });
  });
});

describe("the plain Download's copy, with highlights only", () => {
  const commentOn = async (source: Uint8Array) =>
    await markOn(source, "thirty days", {
      kind: "comment",
      color: null,
      style: null,
      body: "Privileged: check against clause 7.",
    });

  test("writes highlights without any note or author, and leaves comments out", async () => {
    const source = await createTextPdf();
    const highlight = await markOn(source, "deliver the goods");
    const comment = await commentOn(source);
    // The same marks in the full copy carry both the comment and the names.
    const full = await markedBytes(source, [highlight, comment]);
    expect(full.annotationCount).toBe(2);
    expect(
      (await pageOneAnnotations(full.bytes)).map(
        (annotation) => annotation.contents,
      ),
    ).toEqual([null, "Privileged: check against clause 7."]);

    const plain = await markedBytes(source, [highlight, comment], "highlights");

    expect(plain.annotationCount).toBe(1);
    expect(isPrefix(source, plain.bytes)).toBe(true);
    const annotations = await pageOneAnnotations(plain.bytes);
    expect(annotations.map((annotation) => annotation.type)).toEqual([
      "Highlight",
    ]);
    expect(annotations[0]?.contents).toBe(null);
    const [written] =
      (await PDF.load(plain.bytes))
        .getPages()
        .at(0)
        ?.getHighlightAnnotations() ?? [];
    expect(written?.title).toBe(null);
    expect(written?.color).toEqual(pdfMarkColor("yellow"));
    expectSameQuads(
      written?.quadPoints ?? [],
      await expectedQuads(source, highlight),
    );
    // Neither the note nor the author's name is anywhere in the bytes.
    const text = Buffer.from(plain.bytes).toString("latin1");
    expect(text).not.toContain("Privileged");
    expect(text).not.toContain("Alex Author");
  });

  test("hands over the stored bytes when only comments are visible", async () => {
    const source = await createTextPdf();

    expect(
      await write(source, [await commentOn(source)], "highlights"),
    ).toEqual({ status: "unchanged", reason: MARKED_PDF_UNCHANGED.noMarks });
  });
});

describe("a signed PDF with the reader's marks", () => {
  const signedTextPdf = async (certify?: number | null) =>
    await createSignedPdf({
      keyPool,
      unsigned: await createTextPdf(),
      ...(certify !== undefined && { certify }),
    });

  const expectSignaturesIntact = async (
    signed: Uint8Array,
    marked: Uint8Array,
  ) => {
    const integrity = await readSignatureIntegrity(marked);
    expect(integrity.length).toBeGreaterThan(0);
    for (const signature of integrity) {
      expect(signature.digestMatches).toBe(true);
      // Each signature covers a revision inside the signed upload.
      expect(signature.coveredLength).toBeLessThanOrEqual(signed.length);
    }
  };

  test.each(MARKED_PDF_EXPORT_MODES)(
    "adds annotations after an approval signature, which stays valid (%s)",
    async (mode) => {
      const signed = await signedTextPdf();
      const mark = await markOn(signed, "deliver the goods");

      const marked = await markedBytes(signed, [mark], mode);

      expect(isPrefix(signed, marked.bytes)).toBe(true);
      await expectSignaturesIntact(signed, marked.bytes);
      expect(
        (await pageOneAnnotations(marked.bytes)).map(
          (annotation) => annotation.type,
        ),
      ).toContain("Highlight");
    },
  );

  test.each(MARKED_PDF_EXPORT_MODES)(
    "adds annotations to a file certified to allow them, P = 3 (%s)",
    async (mode) => {
      const signed = await signedTextPdf(3);
      const mark = await markOn(signed, "deliver the goods");

      const marked = await markedBytes(signed, [mark], mode);

      expect(isPrefix(signed, marked.bytes)).toBe(true);
      await expectSignaturesIntact(signed, marked.bytes);
    },
  );

  /**
   * A signed file whose signature field locks the document at `level` in its
   * `/Lock` dictionary only, with no FieldMDP transform carrying the level.
   */
  const lockedTextPdf = async (level: number) => {
    const pdf = await PDF.load(await signedTextPdf());
    const resolve = pdf.getObject.bind(pdf);
    const field = pdf
      .getCatalog()
      .getDict("AcroForm", resolve)
      ?.getArray("Fields", resolve)
      ?.at(0, resolve);
    if (!(field instanceof PdfDict)) {
      throw new Error("the signed fixture has no signature field");
    }
    field.set(
      "Lock",
      PdfDict.of({
        Type: PdfName.of("SigFieldLock"),
        Action: PdfName.of("All"),
        P: PdfNumber.of(level),
      }),
    );
    return await pdf.save({ incremental: true });
  };

  test.each([1, 2])(
    "hands over the stored bytes of a file whose field lock forbids annotations (P = %d)",
    async (level) => {
      const locked = await lockedTextPdf(level);
      const mark = await markOn(locked, "deliver the goods");

      for (const mode of MARKED_PDF_EXPORT_MODES) {
        expect(await write(locked, [mark], mode)).toEqual({
          status: "unchanged",
          reason: MARKED_PDF_UNCHANGED.certified,
        });
      }
    },
  );

  test("adds annotations to a file whose field lock allows them (P = 3)", async () => {
    const locked = await lockedTextPdf(3);
    const mark = await markOn(locked, "deliver the goods");

    expect((await markedBytes(locked, [mark])).annotationCount).toBe(1);
  });

  const CERTIFICATIONS = [
    ["no changes (P = 1)", 1],
    ["only form filling and signing (P = 2)", 2],
    ["the default when P is absent (2)", null],
  ] as const;
  test.each(
    CERTIFICATIONS.flatMap(([label, certify]) =>
      MARKED_PDF_EXPORT_MODES.map((mode) => [label, certify, mode] as const),
    ),
  )(
    "hands over the stored bytes of a file certified for %s (%s, %s)",
    async (_, certify, mode) => {
      const signed = await signedTextPdf(certify);
      const mark = await markOn(signed, "deliver the goods");

      expect(await write(signed, [mark], mode)).toEqual({
        status: "unchanged",
        reason: MARKED_PDF_UNCHANGED.certified,
      });
    },
  );
});
