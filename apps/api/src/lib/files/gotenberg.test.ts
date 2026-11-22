import { PDF } from "@libpdf/core";
import { Result } from "better-result";
import { describe, expect, mock, spyOn, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";
import { failureGradeOf, readFailureBrand } from "@stll/errors";
import { waitFor } from "@stll/test-kit";

import {
  DERIVATIVE_REFUSAL,
  DerivativeAdmissionError,
} from "@/api/lib/files/derivative-admission";
import {
  ConversionInputError,
  convertToPdf,
  isConvertibleMimeType,
  isNativelyRenderableMimeType,
  pdfDerivativeStateForFile,
  PdfRenderError,
  shouldGeneratePdfDerivative,
} from "@/api/lib/files/gotenberg";
import { LIMITS } from "@/api/lib/limits";
import { readWorkPoolMetrics } from "@/api/lib/load/work-admission";
import { logger } from "@/api/lib/observability/logger";
import {
  DOCX_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";
import {
  compoundFileWithStreams,
  ebookFile,
  iworkPackage,
  webArchiveFile,
  wordPerfectFile,
} from "@/api/tests/helpers/converted-document-fixtures";
import {
  declaredPng,
  declaredSizePng,
  heicFixture,
  sixteenBitPng,
  splitBmp,
  splitGif,
  splitJpeg,
  splitPng,
  splitTiffPage,
  splitWebp,
  tiffFile,
  withJpegComponents,
} from "@/api/tests/helpers/image-fixtures";
import { legacyWordFile } from "@/api/tests/helpers/legacy-word-fixture";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const testFetchState = createTestFetch();

describe("PDF derivative policy", () => {
  test("does not generate derivatives for natively renderable OOXML files", () => {
    for (const mimeType of [DOCX_MIME_TYPE, PPTX_MIME_TYPE, XLSX_MIME_TYPE]) {
      for (const variant of [
        mimeType,
        `${mimeType.toUpperCase()}; charset=binary`,
      ]) {
        expect(
          shouldGeneratePdfDerivative({
            encrypted: false,
            mimeType: variant,
          }),
        ).toBe(false);

        expect(
          pdfDerivativeStateForFile({
            encrypted: false,
            mimeType: variant,
          }),
        ).toEqual({ status: "not-required" });
      }
    }
  });

  test("generates derivatives for convertible files that are not native", () => {
    expect(
      shouldGeneratePdfDerivative({
        encrypted: false,
        mimeType: "application/msword",
      }),
    ).toBe(true);

    expect(
      pdfDerivativeStateForFile({
        encrypted: false,
        mimeType: "application/msword",
      }),
    ).toEqual({ status: "pending" });
  });

  test("does not generate derivatives for encrypted files", () => {
    expect(
      shouldGeneratePdfDerivative({
        encrypted: true,
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toBe(false);
  });

  test("does not generate PDF derivatives for email files", () => {
    expect(
      shouldGeneratePdfDerivative({
        encrypted: false,
        mimeType: "message/rfc822",
      }),
    ).toBe(false);

    expect(
      shouldGeneratePdfDerivative({
        encrypted: false,
        mimeType: "application/vnd.ms-outlook",
      }),
    ).toBe(false);
  });

  test("does not treat inherited object properties as MIME types", () => {
    for (const inheritedProperty of ["constructor", "toString"]) {
      expect(isConvertibleMimeType(inheritedProperty)).toBe(false);
      expect(isNativelyRenderableMimeType(inheritedProperty)).toBe(false);
    }
  });
});

const requestUrl = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : String(input);

/** Run `convert` with fetch answering `respond`; returns the URLs it called. */
const withConverterFetch = async <T>(
  respond: () => Response,
  convert: () => Promise<T>,
): Promise<{ result: T; urls: string[] }> => {
  const urls: string[] = [];
  const fetchSpy = Object.assign(
    mock(
      asFetchMock(async (input: string | URL | Request) => {
        urls.push(requestUrl(input));
        return respond();
      }),
    ),
    { preconnect: globalThis.fetch.preconnect },
  );
  testFetchState.set(fetchSpy);
  try {
    return { result: await convert(), urls };
  } finally {
    testFetchState.restore();
  }
};

const fileOf = (bytes: Uint8Array, mimeType: string) =>
  testScannedFile({ bytes: bytes.slice().buffer, mimeType });

const PDF_MAGIC = "%PDF-";

describe("PDF conversion routes", () => {
  test.each([
    ["image/png", async () => splitPng(64, 32)],
    ["image/jpeg", async () => await splitJpeg(64, 32, 1)],
  ] as const)(
    "converts %s in-process, never through the converter's browser route",
    async (mimeType, build) => {
      const bytes = await build();
      const { result, urls } = await withConverterFetch(
        () => new Response("unexpected", { status: 500 }),
        async () => await convertToPdf(fileOf(bytes, mimeType)),
      );

      expect(urls).toEqual([]);
      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        const head = new TextDecoder().decode(
          new Uint8Array(result.value.buffer, 0, PDF_MAGIC.length),
        );
        expect(head).toBe(PDF_MAGIC);
        expect(result.value.sizeBytes).toBe(result.value.buffer.byteLength);
      }
    },
  );

  test("refuses an image declaring too many pixels before anything decodes it", async () => {
    const { result, urls } = await withConverterFetch(
      () => new Response("unexpected", { status: 500 }),
      async () =>
        await convertToPdf(
          fileOf(declaredSizePng(20_000, 20_000), "image/png"),
        ),
    );

    expect(urls).toEqual([]);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(DerivativeAdmissionError);
      expect(
        result.error instanceof DerivativeAdmissionError &&
          result.error.refusal,
      ).toBe(DERIVATIVE_REFUSAL.SOURCE_PIXELS);
    }
  });

  test("names an unsupported document field", async () => {
    const archive = new ZipArchive();
    archive.set(
      "word/document.xml",
      new TextEncoder().encode(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:fldSimple w:instr="INCLUDEPICTURE https://example.test/a.png"/></w:document>',
      ),
    );
    const bytes = await archive.generate({ compression: "store" });
    const { result, urls } = await withConverterFetch(
      () => new Response("unexpected", { status: 500 }),
      async () => await convertToPdf(fileOf(bytes, DOCX_MIME_TYPE)),
    );

    expect(urls).toEqual([]);
    expect(Result.isError(result)).toBe(true);
    if (
      Result.isError(result) &&
      result.error instanceof ConversionInputError
    ) {
      expect(result.error.reason).toEqual({
        kind: "unsupported_field",
        fieldType: "INCLUDEPICTURE",
      });
      expect(result.error.message).toBe(
        "The document field INCLUDEPICTURE cannot be converted.",
      );
    }
  });

  test("office files go to the LibreOffice route", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7 converted");
    const { result, urls } = await withConverterFetch(
      () => new Response(pdf),
      async () =>
        await convertToPdf(
          fileOf(legacyWordFile(["ordinary text"]), "application/msword"),
        ),
    );

    expect(urls).toHaveLength(1);
    expect(urls[0]).toEndWith("/forms/libreoffice/convert");
    expect(Result.isOk(result)).toBe(true);
  });

  test.each([
    ["application/rtf", "a spreadsheet declared as RTF"],
    ["application/vnd.apple.pages", "a spreadsheet declared as Pages"],
    ["application/vnd.ms-works", "a spreadsheet declared as Works"],
    ["text/html", "a spreadsheet declared as HTML"],
  ] as const)(
    "never sends the converter %s's content of another format",
    async (mimeType) => {
      const spreadsheet = compoundFileWithStreams(["Workbook"]);
      const { result, urls } = await withConverterFetch(
        () => new Response("unexpected", { status: 500 }),
        async () => await convertToPdf(fileOf(spreadsheet, mimeType)),
      );

      expect(urls).toEqual([]);
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toBeInstanceOf(ConversionInputError);
        expect(
          result.error instanceof ConversionInputError && result.error.reason,
        ).toEqual({ kind: "inspection_failed" });
      }
    },
  );

  test("never sends the converter a type it does not convert", async () => {
    const { result, urls } = await withConverterFetch(
      () => new Response("unexpected", { status: 500 }),
      async () =>
        await convertToPdf(
          fileOf(new TextEncoder().encode("bytes"), "application/x-unknown"),
        ),
    );

    expect(urls).toEqual([]);
    expect(Result.isError(result)).toBe(true);
  });

  test.each([
    ["application/vnd.wordperfect", () => wordPerfectFile(["Synthetic text"])],
    ["application/x-iwork-pages-sffpages", async () => await iworkPackage()],
    ["application/vnd.apple.numbers", async () => await iworkPackage()],
    ["application/vnd.ms-works", () => compoundFileWithStreams(["MN0"])],
  ] as const)("%s goes to the LibreOffice route", async (mimeType, build) => {
    const bytes = await build();
    const { result, urls } = await withConverterFetch(
      () => new Response(new TextEncoder().encode("%PDF-1.7 converted")),
      async () => await convertToPdf(fileOf(bytes, mimeType)),
    );

    expect(urls).toHaveLength(1);
    expect(urls[0]).toEndWith("/forms/libreoffice/convert");
    expect(Result.isOk(result)).toBe(true);
  });

  test("returns an error when document inspection cannot read the archive", async () => {
    const { result, urls } = await withConverterFetch(
      () => new Response("unexpected", { status: 500 }),
      async () =>
        await convertToPdf(
          fileOf(new TextEncoder().encode("not a zip"), DOCX_MIME_TYPE),
        ),
    );

    expect(Result.isError(result)).toBe(true);
    expect(urls).toEqual([]);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(ConversionInputError);
      expect(
        result.error instanceof ConversionInputError && result.error.reason,
      ).toEqual({
        kind: "inspection_failed",
      });
    }
  });

  test.each([
    [
      "application/vnd.ms-excel",
      ".xlsx",
      "Re-save this document as .xlsx to convert it.",
    ],
    [
      "application/vnd.ms-powerpoint",
      ".pptx",
      "Re-save this document as .pptx to convert it.",
    ],
  ] as const)(
    "names the replacement for %s",
    async (mimeType, extension, message) => {
      const { result, urls } = await withConverterFetch(
        () => new Response("unexpected", { status: 500 }),
        async () => await convertToPdf(fileOf(new Uint8Array(), mimeType)),
      );

      expect(urls).toEqual([]);
      expect(Result.isError(result)).toBe(true);
      if (
        Result.isError(result) &&
        result.error instanceof ConversionInputError
      ) {
        expect(result.error.reason).toEqual({
          kind: "legacy_format",
          replacementExtension: extension,
        });
        expect(result.error.message).toBe(message);
      }
    },
  );

  test("refuses a converter response whose declared length exceeds the PDF cap", async () => {
    const { result, urls } = await withConverterFetch(
      () =>
        new Response("", {
          headers: {
            "Content-Length": String(LIMITS.fileDerivativePdfMaxBytes + 1),
          },
        }),
      async () =>
        await convertToPdf(
          fileOf(legacyWordFile(["ordinary text"]), "application/msword"),
          {
            retry: "caller",
          },
        ),
    );

    expect(urls).toHaveLength(1);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ kind: "response-too-large" });
    }
  });

  test("cancels a converter response when streamed bytes cross the PDF cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      start: (controller) => {
        controller.enqueue(new Uint8Array(LIMITS.fileDerivativePdfMaxBytes));
        controller.enqueue(new Uint8Array([1]));
      },
    });
    const { result } = await withConverterFetch(
      () => new Response(body),
      async () =>
        await convertToPdf(
          fileOf(legacyWordFile(["ordinary text"]), "application/msword"),
          {
            retry: "caller",
          },
        ),
    );

    expect(cancelled).toBe(true);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ kind: "response-too-large" });
    }
  });

  test("accepts a converter response exactly at the PDF cap", async () => {
    const body = new Uint8Array(LIMITS.fileDerivativePdfMaxBytes);
    const { result } = await withConverterFetch(
      () => new Response(body),
      async () =>
        await convertToPdf(
          fileOf(legacyWordFile(["ordinary text"]), "application/msword"),
          {
            retry: "caller",
          },
        ),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.sizeBytes).toBe(LIMITS.fileDerivativePdfMaxBytes);
    }
  });

  test("a caller-owned retry makes exactly one converter call per conversion", async () => {
    const { result, urls } = await withConverterFetch(
      () => new Response("busy", { status: 503 }),
      async () =>
        await convertToPdf(
          fileOf(legacyWordFile(["ordinary text"]), "application/msword"),
          {
            retry: "caller",
          },
        ),
    );

    expect(Result.isError(result)).toBe(true);
    expect(urls).toHaveLength(1);
  });
});

const EMBED_FAILED_EVENT = "file_conversion.image_embed_failed";
const RENDER_FAILED_EVENT = "file_conversion.render_failed";

/**
 * Run `convert` with the converter answering a PDF; returns its calls and
 * the in-process failures observed.
 */
const convertWithConverterStub = async (
  convert: () => ReturnType<typeof convertToPdf>,
) => {
  const events: string[] = [];
  const record = (event: string) => {
    events.push(event);
  };
  const warn = spyOn(logger, "warn").mockImplementation(record);
  const error = spyOn(logger, "error").mockImplementation(record);
  try {
    const { result, urls } = await withConverterFetch(
      () => new Response(new TextEncoder().encode("%PDF-1.7 converted")),
      convert,
    );
    return {
      failures: events.filter(
        (event) =>
          event === EMBED_FAILED_EVENT || event === RENDER_FAILED_EVENT,
      ),
      result,
      urls,
    };
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
};

/** The page count of a PDF conversion result. */
const pageCountOf = async (buffer: ArrayBuffer) =>
  (await PDF.load(new Uint8Array(buffer))).getPageCount();

describe("HEIC/HEIF photos", () => {
  const noPreview = (cause: "decoding_off" | "unreadable", format = "HEIC") =>
    ({ kind: "no_preview", format, cause }) as const;

  const refusalOf = (
    result: Awaited<ReturnType<typeof convertToPdf>>,
  ): unknown =>
    Result.isError(result) && result.error instanceof ConversionInputError
      ? result.error.reason
      : null;

  test.each([
    ["image/heic", "HEIC"],
    ["image/heic-sequence", "HEIC"],
    ["image/heif", "HEIF"],
    ["image/heif-sequence", "HEIF"],
  ] as const)(
    "with decoding off, a %s file has no preview and nothing decodes it",
    async (mimeType, format) => {
      const { failures, result, urls } = await convertWithConverterStub(
        async () =>
          await convertToPdf(fileOf(heicFixture("grid.heic"), mimeType), {
            heifDecoding: false,
          }),
      );

      expect(urls).toEqual([]);
      expect(failures).toEqual([]);
      expect(refusalOf(result)).toEqual(noPreview("decoding_off", format));
    },
  );

  test("with decoding on, a photo renders as one page in the worker", async () => {
    const { failures, result, urls } = await convertWithConverterStub(
      async () =>
        await convertToPdf(fileOf(heicFixture("grid.heic"), "image/heic"), {
          heifDecoding: true,
        }),
    );

    expect(urls).toEqual([]);
    expect(failures).toEqual([]);
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(await pageCountOf(result.value.buffer)).toBe(1);
    }
  });

  test.each([
    ["a container that cannot be read", new TextEncoder().encode("not HEIF")],
    // The header reads; the tiles' pictures are cut off.
    [
      "pictures that cannot be read",
      heicFixture("grid.heic").subarray(0, 3000),
    ],
  ] as const)("%s has no preview", async (_label, bytes) => {
    const { result, urls } = await convertWithConverterStub(
      async () =>
        await convertToPdf(fileOf(bytes, "image/heic"), {
          heifDecoding: true,
        }),
    );

    expect(urls).toEqual([]);
    expect(refusalOf(result)).toEqual(noPreview("unreadable"));
  });
});

describe("images, plain text and CSV are rendered by stella, never the converter", () => {
  test.each([
    ["image/bmp", () => splitBmp(16, 8), 1],
    ["image/gif", () => splitGif(16, 8, 2), 1],
    [
      "image/tiff",
      () => tiffFile([splitTiffPage(16, 8), splitTiffPage(8, 8, 6)]),
      2,
    ],
    [
      "image/tiff",
      () =>
        tiffFile([
          { width: 8, height: 8, cmyk: true, pixel: () => [0, 255, 255, 0] },
        ]),
      1,
    ],
    ["image/png", () => sixteenBitPng(8, 8), 1],
    ["image/webp", async () => await splitWebp(16, 8), 1],
    ["text/plain", () => new TextEncoder().encode("Synthetic notes"), 1],
    ["text/csv", () => new TextEncoder().encode("a,b\n1,2\n"), 1],
  ] as const)("%s", async (mimeType, build, pages) => {
    const { failures, result, urls } = await convertWithConverterStub(
      async () => await convertToPdf(fileOf(await build(), mimeType)),
    );

    expect(urls).toEqual([]);
    expect(failures).toEqual([]);
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(await pageCountOf(result.value.buffer)).toBe(pages);
      expect(result.value.sizeBytes).toBe(result.value.buffer.byteLength);
    }
  });

  test.each(["rgb", "rgba", "palette"] as const)(
    "an 8-bit %s PNG still embeds directly",
    async (color) => {
      const { failures, result, urls } = await convertWithConverterStub(
        async () =>
          await convertToPdf(fileOf(splitPng(16, 8, color), "image/png")),
      );

      expect(urls).toEqual([]);
      expect(failures).toEqual([]);
      expect(Result.isOk(result)).toBe(true);
    },
  );

  test.each([
    [
      "an interlaced PNG with no image data",
      () => declaredPng({ width: 8, height: 8, interlaced: true }),
      "image/png",
    ],
    [
      "a JPEG declaring four components over a three-component scan",
      async () => withJpegComponents(await splitJpeg(16, 8, 1), 4),
      "image/jpeg",
    ],
  ] as const)(
    "%s is a typed, observed refusal and never reaches the converter",
    async (_name, build, mimeType) => {
      const { failures, result, urls } = await convertWithConverterStub(
        async () => await convertToPdf(fileOf(await build(), mimeType)),
      );

      expect(urls).toEqual([]);
      expect(failures).toEqual([RENDER_FAILED_EVENT]);
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toBeInstanceOf(PdfRenderError);
        expect(
          result.error instanceof PdfRenderError && result.error.reason,
        ).toBe("unreadable");
      }
    },
  );

  test("an embed that fails anyway is rendered by the worker, both observed", async () => {
    // The header declares an embeddable 8-bit RGB image, but there is no
    // image data, so the embedder refuses it and so does the decoder.
    const { failures, result, urls } = await convertWithConverterStub(
      async () =>
        await convertToPdf(fileOf(declaredSizePng(8, 8), "image/png")),
    );

    expect(failures).toEqual([EMBED_FAILED_EVENT, RENDER_FAILED_EVENT]);
    expect(urls).toEqual([]);
    expect(Result.isError(result)).toBe(true);
  });

  test("a refusal grades as the file's answer, a worker failure as a defect", () => {
    const grade = (reason: PdfRenderError["reason"]) =>
      failureGradeOf(
        readFailureBrand(new PdfRenderError({ message: "render", reason }))
          ?.reason ?? "tagged_failure",
      );
    expect(grade("unreadable")).toBe("anticipated");
    expect(grade("too-large")).toBe("anticipated");
    // Past the memory ceiling, a bound on the source let it through.
    expect(grade("memory")).toBe("defect");
    expect(grade("busy")).toBe("transient");
    expect(grade("failed")).toBe("defect");
  });

  test("renders run one at a time; the others wait for the slot", async () => {
    const pool = () => readWorkPoolMetrics()["pdf-render"];
    const minutes = (index: number) =>
      new TextEncoder().encode(
        `Zápis z jednání představenstva č. ${index}\nPřítomni: Ing. Marek Doležal, JUDr. Hana Kratochvílová\n`,
      );
    const renders = Promise.all(
      [1, 2, 3].map(
        async (index) =>
          await convertToPdf(fileOf(minutes(index), "text/plain")),
      ),
    );
    const waiting = await waitFor(
      () => {
        const stats = pool();
        return stats.queued === 3 - LIMITS.workPoolPdfRenderSlots
          ? stats
          : undefined;
      },
      { description: "the renders past the slot to queue for it" },
    );
    expect(waiting.inFlight).toBe(LIMITS.workPoolPdfRenderSlots);
    // Queued, not refused: every render past the slot waited for it.
    const results = await renders;
    expect(results.every((result) => Result.isOk(result))).toBe(true);
    expect(pool()).toMatchObject({ inFlight: 0, queued: 0, refusedBusy: 0 });
  });

  test("a refusal is the same answer on every attempt", async () => {
    const corrupt = (await splitWebp(64, 32)).fill(0xff, 25);
    const reasons: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { result, urls } = await convertWithConverterStub(
        async () => await convertToPdf(fileOf(corrupt, "image/webp")),
      );
      expect(urls).toEqual([]);
      reasons.push(
        Result.isError(result) && result.error instanceof PdfRenderError
          ? result.error.reason
          : null,
      );
    }
    expect(reasons).toEqual(["unreadable", "unreadable"]);
  });
});

/** The multipart filename of the one upload `convert` sends to the converter. */
const uploadedFileName = async (
  convert: () => ReturnType<typeof convertToPdf>,
): Promise<string | undefined> => {
  const bodies: string[] = [];
  const fetchSpy = Object.assign(
    mock(
      asFetchMock(
        async (_input: string | URL | Request, init?: RequestInit) => {
          bodies.push(await new Response(init?.body).text());
          return new Response(new TextEncoder().encode("%PDF-1.7 converted"));
        },
      ),
    ),
    { preconnect: globalThis.fetch.preconnect },
  );
  testFetchState.set(fetchSpy);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await convert();
  } finally {
    testFetchState.restore();
    warn.mockRestore();
  }
  expect(bodies).toHaveLength(1);
  return /; filename="([^"]*)"/u.exec(bodies[0] ?? "")?.[1];
};

const namedFileOf = (bytes: Uint8Array, mimeType: string, path: string) =>
  testScannedFile({ bytes: bytes.slice().buffer, mimeType, path });

describe("converter upload filenames", () => {
  test("a document with the wrong extension has it replaced", async () => {
    expect(
      await uploadedFileName(
        async () =>
          await convertToPdf(
            namedFileOf(
              legacyWordFile(["ordinary text"]),
              "application/msword",
              "brief.dat",
            ),
          ),
      ),
    ).toBe("brief.doc");
  });

  test("an accepted alternative extension is kept", async () => {
    expect(
      await uploadedFileName(
        async () =>
          await convertToPdf(
            namedFileOf(
              legacyWordFile(["ordinary text"]),
              "application/msword",
              "Template.DOT",
            ),
          ),
      ),
    ).toBe("Template.DOT");
  });

  test.each([
    [
      "application/vnd.wordperfect",
      "smlouva.wp5",
      "smlouva.wpd",
      () => wordPerfectFile(["Synthetic text"]),
    ],
    [
      "application/x-wordperfect",
      "smlouva",
      "smlouva.wpd",
      () => wordPerfectFile(["Synthetic text"]),
    ],
    [
      "application/x-iwork-pages-sffpages",
      "nabidka",
      "nabidka.pages",
      async () => await iworkPackage(),
    ],
    [
      "application/msword",
      "brief",
      "brief.doc",
      () => legacyWordFile(["ordinary text"]),
    ],
  ] as const)(
    "a %s file named %s is uploaded as %s",
    async (mimeType, name, uploaded, build) => {
      const bytes = await build();
      expect(
        await uploadedFileName(
          async () => await convertToPdf(namedFileOf(bytes, mimeType, name)),
        ),
      ).toBe(uploaded);
    },
  );

  test.each([
    [
      "multipart/related",
      "notice.mht",
      () => webArchiveFile({ body: "<p>Synthetic notice</p>" }),
    ],
    [
      "application/epub+zip",
      "book.epub",
      async () =>
        await ebookFile({
          chapters: [{ file: "one.xhtml", body: "<p>Synthetic chapter</p>" }],
        }),
    ],
  ] as const)(
    "a %s file goes to the converter as the HTML rendered from it",
    async (mimeType, name, build) => {
      const bytes = await build();
      expect(
        await uploadedFileName(
          async () => await convertToPdf(namedFileOf(bytes, mimeType, name)),
        ),
      ).toBe(`${name.slice(0, name.lastIndexOf("."))}.html`);
      expect(shouldGeneratePdfDerivative({ encrypted: false, mimeType })).toBe(
        true,
      );
    },
  );

  test("a type declared with parameters converts as its type", async () => {
    const bytes = webArchiveFile({ body: "<p>Synthetic notice</p>" });
    expect(
      await uploadedFileName(
        async () =>
          await convertToPdf(
            namedFileOf(
              bytes,
              'multipart/related; type="text/html"; boundary="x"',
              "notice.mht",
            ),
          ),
      ),
    ).toBe("notice.html");
    expect(
      shouldGeneratePdfDerivative({
        encrypted: false,
        mimeType: "Multipart/Related; boundary=x",
      }),
    ).toBe(true);
  });

  test("a web archive with no page never reaches the converter", async () => {
    const { result, urls } = await withConverterFetch(
      () => new Response("unexpected", { status: 500 }),
      async () =>
        await convertToPdf(
          fileOf(
            new TextEncoder().encode(
              "MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nText\r\n",
            ),
            "multipart/related",
          ),
        ),
    );
    expect(urls).toEqual([]);
    expect(
      Result.isError(result) &&
        result.error instanceof ConversionInputError &&
        result.error.reason,
    ).toEqual({ kind: "inspection_failed" });
  });

  test("a file keeps an extension the converter accepts for its type", async () => {
    expect(
      await uploadedFileName(
        async () =>
          await convertToPdf(
            namedFileOf(
              legacyWordFile(["ordinary text"]),
              "application/msword",
              "brief.doc",
            ),
          ),
      ),
    ).toBe("brief.doc");
  });
});
