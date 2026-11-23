import { describe, expect, mock, test } from "bun:test";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import {
  FILE_PART_CONVERTED_MEDIA_TYPES,
  isFilePartConvertedMediaType,
} from "@stll/api-contract/file-parts";

import type { FilePartRead } from "@/api/lib/files/file-part";
import {
  filePartDisplayIdentity,
  filePartForDisplay,
} from "@/api/lib/files/file-part-rendition";
import {
  canConvertToPdf,
  isNativelyRenderableMimeType,
} from "@/api/lib/files/gotenberg";
import { LIMITS } from "@/api/lib/limits";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { wordPerfectFile } from "@/api/tests/helpers/converted-document-fixtures";
import { legacyWordFile } from "@/api/tests/helpers/legacy-word-fixture";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const testFetchState = createTestFetch();

const CONVERTED_PDF = new TextEncoder().encode("%PDF-1.7 converted rendition");

/** Run `display` with the converter answering `respond`; returns the URLs called. */
const withConverter = async <T>(
  respond: () => Response,
  display: () => Promise<T>,
): Promise<{ result: T; urls: string[] }> => {
  const urls: string[] = [];
  testFetchState.set(
    Object.assign(
      mock(
        asFetchMock(async (input: string | URL | Request) => {
          urls.push(input instanceof Request ? input.url : String(input));
          return respond();
        }),
      ),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    return { result: await display(), urls };
  } finally {
    testFetchState.restore();
  }
};

// A court's enclosures as a data-box message carries them.
const enclosure = (
  fileName: string,
  mimeType: string,
  bytes: Uint8Array,
): FilePartRead => ({ bytes, fileName, mimeType });

const wordEnclosure = enclosure(
  "Vyjadreni_zalovane_9C214-2026.doc",
  "application/msword",
  legacyWordFile(["Žalovaná se k žalobě vyjadřuje tak, že nárok neuznává."]),
);

describe("a part delivered for display", () => {
  test("a Word 97 enclosure displays as the PDF the converter makes of it", async () => {
    const { result, urls } = await withConverter(
      () => new Response(CONVERTED_PDF),
      async () => await filePartForDisplay(wordEnclosure),
    );

    expect(urls).toHaveLength(1);
    expect(urls[0]).toEndWith("/forms/libreoffice/convert");
    const shown = result.unwrap();
    expect(shown.mimeType).toBe(PDF_MIME_TYPE);
    expect(shown.fileName).toBe("Vyjadreni_zalovane_9C214-2026.pdf");
    expect(shown.bytes).toEqual(CONVERTED_PDF);
    // The grant was issued under the same name and type.
    expect(filePartDisplayIdentity(wordEnclosure)).toEqual({
      fileName: shown.fileName,
      mimeType: shown.mimeType,
    });
  });

  test("a WordPerfect enclosure goes the same way", async () => {
    const { result, urls } = await withConverter(
      () => new Response(CONVERTED_PDF),
      async () =>
        await filePartForDisplay(
          enclosure(
            "Smlouva_o_prodeji_podniku_2026-114.wpd",
            "application/vnd.wordperfect",
            wordPerfectFile(["SMLOUVA O PRODEJI ZÁVODU", "Článek 1"]),
          ),
        ),
    );

    expect(urls).toHaveLength(1);
    expect(result.unwrap()).toMatchObject({
      fileName: "Smlouva_o_prodeji_podniku_2026-114.pdf",
      mimeType: PDF_MIME_TYPE,
    });
  });

  test("a part the viewers draw as it is never reaches the converter", async () => {
    for (const part of [
      enclosure("Zaloba_9C214-2026.docx", DOCX_MIME_TYPE, CONVERTED_PDF),
      enclosure("Usneseni_9C214-2026.pdf", PDF_MIME_TYPE, CONVERTED_PDF),
      enclosure(
        "Pouceni_ucastniku.txt",
        "text/plain",
        new TextEncoder().encode("Poučení účastníků řízení"),
      ),
    ]) {
      const { result, urls } = await withConverter(
        () => new Response("unexpected", { status: 500 }),
        async () => await filePartForDisplay(part),
      );
      expect(urls).toEqual([]);
      expect(result.unwrap()).toBe(part);
      expect(filePartDisplayIdentity(part)).toEqual({
        fileName: part.fileName,
        mimeType: part.mimeType,
      });
    }
  });

  test("a part above the conversion budget has no preview and is never read", async () => {
    const { result, urls } = await withConverter(
      () => new Response(CONVERTED_PDF),
      async () =>
        await filePartForDisplay(
          enclosure(
            "Spis_9C214-2026.doc",
            "application/msword",
            new Uint8Array(LIMITS.fileDerivativeSourceMaxBytes + 1),
          ),
        ),
    );

    expect(urls).toEqual([]);
    expect(result.isErr() && result.error).toMatchObject({
      status: 422,
      code: PREVIEW_UNAVAILABLE_ERROR_CODE,
    });
  });

  test("a document whose content is not its declared format has no preview", async () => {
    const { result, urls } = await withConverter(
      () => new Response(CONVERTED_PDF),
      async () =>
        await filePartForDisplay(
          enclosure(
            "Vyjadreni.wpd",
            "application/vnd.wordperfect",
            new TextEncoder().encode("Prostý text vydávaný za WordPerfect."),
          ),
        ),
    );

    expect(urls).toEqual([]);
    expect(result.isErr() && result.error).toMatchObject({
      status: 422,
      code: PREVIEW_UNAVAILABLE_ERROR_CODE,
    });
  });

  test("a converter that answers without a PDF is a failed read, not a missing preview", async () => {
    // A 4xx answer is not retried, so the request settles at once.
    const { result, urls } = await withConverter(
      () => new Response("bad request", { status: 400 }),
      async () => await filePartForDisplay(wordEnclosure),
    );

    expect(urls).toHaveLength(1);
    expect(result.isErr() && result.error.status).toBe(502);
  });

  test("a rendition over the PDF size cap has no preview, as another attempt gives the same", async () => {
    const { result, urls } = await withConverter(
      () =>
        new Response("", {
          headers: {
            "Content-Length": String(LIMITS.fileDerivativePdfMaxBytes + 1),
          },
        }),
      async () => await filePartForDisplay(wordEnclosure),
    );

    expect(urls).toHaveLength(1);
    expect(result.isErr() && result.error).toMatchObject({
      status: 422,
      code: PREVIEW_UNAVAILABLE_ERROR_CODE,
    });
  });

  test("every converted part type is one the converter takes and no viewer draws", () => {
    expect(FILE_PART_CONVERTED_MEDIA_TYPES.size).toBeGreaterThan(0);
    for (const mediaType of FILE_PART_CONVERTED_MEDIA_TYPES) {
      expect(canConvertToPdf(mediaType)).toBeTrue();
      expect(isNativelyRenderableMimeType(mediaType)).toBeFalse();
      expect(
        isFilePartConvertedMediaType(`${mediaType.toUpperCase()}; x=1`),
      ).toBeTrue();
    }
  });
});
