import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";
import JSZip from "jszip";

import { writeZipEntry } from "@stll/docx-utils";

import {
  DERIVATIVE_REFUSAL,
  DerivativeAdmissionError,
} from "@/api/lib/files/derivative-admission";
import {
  ConversionInputError,
  convertToPdf,
  ImageTranscodeError,
  isConvertibleMimeType,
  isNativelyRenderableMimeType,
  pdfDerivativeStateForFile,
  shouldGeneratePdfDerivative,
} from "@/api/lib/files/gotenberg";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import {
  DOCX_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";
import {
  declaredPng,
  declaredSizePng,
  splitJpeg,
  splitPng,
  splitWebp,
  withJpegComponents,
} from "@/api/tests/helpers/image-fixtures";
import { legacyWordFile } from "@/api/tests/helpers/legacy-word-fixture";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

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
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    asFetchMock(async (input: string | URL | Request) => {
      urls.push(requestUrl(input));
      return respond();
    }),
  );
  try {
    return { result: await convert(), urls };
  } finally {
    fetchSpy.mockRestore();
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
    const archive = new JSZip();
    writeZipEntry(
      archive,
      "word/document.xml",
      new TextEncoder().encode(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:fldSimple w:instr="INCLUDEPICTURE https://example.test/a.png"/></w:document>',
      ),
    );
    const bytes = await archive.generateAsync({ type: "uint8array" });
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

/** Run `convert` with the converter answering a PDF; returns its calls and the embed failures observed. */
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
      embedFailures: events.filter((event) => event === EMBED_FAILED_EVENT),
      result,
      urls,
    };
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
};

const LIBREOFFICE_ROUTE = "/forms/libreoffice/convert";

describe("image encodings the in-process embedder cannot take", () => {
  test.each([
    [
      "an interlaced PNG",
      () => declaredPng({ width: 8, height: 8, interlaced: true }),
    ],
    ["a 16-bit PNG", () => declaredPng({ width: 8, height: 8, bitDepth: 16 })],
    [
      "a 4-bit palette PNG",
      () => declaredPng({ width: 8, height: 8, bitDepth: 4, colorType: 3 }),
    ],
  ] as const)(
    "%s goes to LibreOffice without trying the embedder",
    async (_name, build) => {
      const { embedFailures, result, urls } = await convertWithConverterStub(
        async () => await convertToPdf(fileOf(build(), "image/png")),
      );

      expect(embedFailures).toEqual([]);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toEndWith(LIBREOFFICE_ROUTE);
      expect(Result.isOk(result)).toBe(true);
    },
  );

  test("a four-component (CMYK) JPEG goes to LibreOffice", async () => {
    const cmyk = withJpegComponents(await splitJpeg(16, 8, 1), 4);
    const { embedFailures, urls } = await convertWithConverterStub(
      async () => await convertToPdf(fileOf(cmyk, "image/jpeg")),
    );

    expect(embedFailures).toEqual([]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toEndWith(LIBREOFFICE_ROUTE);
  });

  test.each(["rgb", "rgba", "palette"] as const)(
    "an 8-bit %s PNG still embeds in-process",
    async (color) => {
      const { embedFailures, result, urls } = await convertWithConverterStub(
        async () =>
          await convertToPdf(fileOf(splitPng(16, 8, color), "image/png")),
      );

      expect(urls).toEqual([]);
      expect(embedFailures).toEqual([]);
      expect(Result.isOk(result)).toBe(true);
    },
  );

  test("an embed that fails anyway falls back to LibreOffice, observed once", async () => {
    // The header declares an embeddable 8-bit RGB image, but there is no
    // image data, so the embedder itself refuses it.
    const { embedFailures, result, urls } = await convertWithConverterStub(
      async () =>
        await convertToPdf(fileOf(declaredSizePng(8, 8), "image/png")),
    );

    expect(embedFailures).toEqual([EMBED_FAILED_EVENT]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toEndWith(LIBREOFFICE_ROUTE);
    expect(Result.isOk(result)).toBe(true);
  });
});

/** The multipart filename of the one upload `convert` sends to the converter. */
const uploadedFileName = async (
  convert: () => ReturnType<typeof convertToPdf>,
): Promise<string | undefined> => {
  const bodies: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    asFetchMock(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(await new Response(init?.body).text());
      return new Response(new TextEncoder().encode("%PDF-1.7 converted"));
    }),
  );
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await convert();
  } finally {
    fetchSpy.mockRestore();
    warn.mockRestore();
  }
  expect(bodies).toHaveLength(1);
  return /; filename="([^"]*)"/u.exec(bodies[0] ?? "")?.[1];
};

const namedFileOf = (bytes: Uint8Array, mimeType: string, path: string) =>
  testScannedFile({ bytes: bytes.slice().buffer, mimeType, path });

describe("converter upload filenames", () => {
  test("an image named without an extension is uploaded with its type's", async () => {
    const png = declaredPng({ width: 8, height: 8, interlaced: true });
    expect(
      await uploadedFileName(
        async () => await convertToPdf(namedFileOf(png, "image/png", "scan")),
      ),
    ).toBe("scan.png");
  });

  test("an image with the wrong extension has it replaced", async () => {
    const cmyk = withJpegComponents(await splitJpeg(16, 8, 1), 4);
    expect(
      await uploadedFileName(
        async () =>
          await convertToPdf(namedFileOf(cmyk, "image/jpeg", "photo.dat")),
      ),
    ).toBe("photo.jpg");
  });

  test("an accepted alternative extension is kept", async () => {
    const cmyk = withJpegComponents(await splitJpeg(16, 8, 1), 4);
    expect(
      await uploadedFileName(
        async () =>
          await convertToPdf(namedFileOf(cmyk, "image/jpeg", "Photo.JPEG")),
      ),
    ).toBe("Photo.JPEG");
  });

  test("other types keep the uploaded name", async () => {
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

const TRANSCODE_FAILED_EVENT = "file_conversion.image_transcode_failed";

describe("image types the converter cannot import", () => {
  test("a WebP becomes a PDF in-process, never through the converter", async () => {
    const webp = await splitWebp(64, 32);
    const { result, urls } = await withConverterFetch(
      () => new Response("unexpected", { status: 500 }),
      async () => await convertToPdf(fileOf(webp, "image/webp")),
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
  });

  test("a corrupt WebP is a typed, observed error and never reaches the converter", async () => {
    // A readable header over a garbage bitstream: admission passes and the
    // decoder refuses it. VP8L dimensions end at byte 25.
    const corrupt = (await splitWebp(64, 32)).fill(0xff, 25);
    const events: string[] = [];
    const record = (event: string) => {
      events.push(event);
    };
    const warn = spyOn(logger, "warn").mockImplementation(record);
    const error = spyOn(logger, "error").mockImplementation(record);
    try {
      const { result, urls } = await withConverterFetch(
        () => new Response("unexpected", { status: 500 }),
        async () => await convertToPdf(fileOf(corrupt, "image/webp")),
      );

      expect(urls).toEqual([]);
      expect(
        events.filter((event) => event === TRANSCODE_FAILED_EVENT),
      ).toEqual([TRANSCODE_FAILED_EVENT]);
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toBeInstanceOf(ImageTranscodeError);
      }
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
