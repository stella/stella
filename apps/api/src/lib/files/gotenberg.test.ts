import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import {
  DERIVATIVE_REFUSAL,
  DerivativeAdmissionError,
} from "@/api/lib/files/derivative-admission";
import {
  convertToPdf,
  isConvertibleMimeType,
  isNativelyRenderableMimeType,
  pdfDerivativeStateForFile,
  shouldGeneratePdfDerivative,
} from "@/api/lib/files/gotenberg";
import {
  DOCX_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";
import {
  declaredSizePng,
  splitJpeg,
  splitPng,
} from "@/api/tests/helpers/image-fixtures";
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

  test("office files go to the LibreOffice route", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7 converted");
    const { result, urls } = await withConverterFetch(
      () => new Response(pdf),
      async () =>
        await convertToPdf(
          fileOf(new TextEncoder().encode("doc"), "application/msword"),
        ),
    );

    expect(urls).toHaveLength(1);
    expect(urls[0]).toEndWith("/forms/libreoffice/convert");
    expect(Result.isOk(result)).toBe(true);
  });

  test("a caller-owned retry makes exactly one converter call per conversion", async () => {
    const { result, urls } = await withConverterFetch(
      () => new Response("busy", { status: 503 }),
      async () =>
        await convertToPdf(
          fileOf(new TextEncoder().encode("doc"), "application/msword"),
          { retry: "caller" },
        ),
    );

    expect(Result.isError(result)).toBe(true);
    expect(urls).toHaveLength(1);
  });
});
