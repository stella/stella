import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DeepLDocumentError, DeepLUpstreamError } from "@/api/lib/deepl/errors";

import {
  DEEPL_TEXT_REQUEST_MAX_BYTES,
  DEEPL_TEXT_REQUEST_MAX_ITEMS,
  partitionDeepLTextBatches,
  translateDocument,
  translateTextBatch,
  translateTextBatches,
} from "./client";

const originalFetch = globalThis.fetch;
const originalSleep = Bun.sleep;

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });

const toFetchUrl = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
};

type FetchHandler = (input: Parameters<typeof fetch>[0]) => Promise<Response>;

const installFetchMock = (handler: FetchHandler) => {
  globalThis.fetch = Object.assign(handler, {
    preconnect: originalFetch.preconnect.bind(originalFetch),
  }) satisfies typeof fetch;
};

const translateDocx = async () =>
  await translateDocument({
    apiKey: "deepl-key",
    file: new Uint8Array([1, 2, 3]),
    fileName: "Source.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    targetLang: "DE",
  });

describe("DeepL document translation status errors", () => {
  beforeEach(() => {
    Bun.sleep = async () => {};
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
  });

  test("surfaces the documented status message field", async () => {
    const providerMessage = "Source and target language are equal.";
    installFetchMock(async (input) => {
      const url = toFetchUrl(input);

      if (url.endsWith("/v2/document")) {
        return jsonResponse({
          document_id: "document-id",
          document_key: "document-key",
        });
      }

      if (url.endsWith("/v2/document/document-id")) {
        return jsonResponse({
          document_id: "document-id",
          status: "error",
          message: providerMessage,
        });
      }

      return new Response("unexpected DeepL endpoint", { status: 500 });
    });

    try {
      await translateDocx();
      throw new Error("expected DeepL document error");
    } catch (error) {
      expect(DeepLDocumentError.is(error)).toBe(true);
      if (!DeepLDocumentError.is(error)) {
        throw error;
      }
      expect(error.detail).toBe(providerMessage);
    }
  });

  test("maps malformed upload payloads to upstream errors", async () => {
    installFetchMock(async (input) => {
      const url = toFetchUrl(input);

      if (url.endsWith("/v2/document")) {
        return jsonResponse({ document_id: "document-id" });
      }

      return new Response("unexpected DeepL endpoint", { status: 500 });
    });

    try {
      await translateDocx();
      throw new Error("expected DeepL upstream error");
    } catch (error) {
      expect(DeepLUpstreamError.is(error)).toBe(true);
      if (!DeepLUpstreamError.is(error)) {
        throw error;
      }
      expect(error.message).toBe(
        "DeepL returned a malformed document upload response",
      );
    }
  });

  test("maps malformed status payloads to upstream errors", async () => {
    installFetchMock(async (input) => {
      const url = toFetchUrl(input);

      if (url.endsWith("/v2/document")) {
        return jsonResponse({
          document_id: "document-id",
          document_key: "document-key",
        });
      }

      if (url.endsWith("/v2/document/document-id")) {
        return jsonResponse({ document_id: "document-id" });
      }

      return new Response("unexpected DeepL endpoint", { status: 500 });
    });

    try {
      await translateDocx();
      throw new Error("expected DeepL upstream error");
    } catch (error) {
      expect(DeepLUpstreamError.is(error)).toBe(true);
      if (!DeepLUpstreamError.is(error)) {
        throw error;
      }
      expect(error.message).toBe(
        "DeepL returned a malformed document status response",
      );
    }
  });
});

describe("DeepL text translation", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("translates comment text in input order", async () => {
    installFetchMock(async (input) => {
      expect(toFetchUrl(input)).toEndWith("/v2/translate");
      return jsonResponse({
        translations: [
          { detected_source_language: "EN", text: "Erste" },
          { detected_source_language: "EN", text: "Zweite" },
        ],
      });
    });

    expect(
      await translateTextBatch({
        apiKey: "deepl-key",
        texts: ["First", "Second"],
        targetLang: "DE",
        sourceLang: "EN",
      }),
    ).toEqual(["Erste", "Zweite"]);
  });

  test("rejects incomplete comment translations", async () => {
    installFetchMock(async () =>
      jsonResponse({
        translations: [{ detected_source_language: "EN", text: "Erste" }],
      }),
    );

    const resultError = await translateTextBatch({
      apiKey: "deepl-key",
      texts: ["First", "Second"],
      targetLang: "DE",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(DeepLUpstreamError.is(resultError)).toBeTrue();
  });

  test("partitions requests by serialized UTF-8 bytes and preserves order", async () => {
    const texts = ["a".repeat(70_000), "b".repeat(70_000)];
    expect(
      partitionDeepLTextBatches({ texts, targetLang: "DE" }).map(
        (batch) => batch.length,
      ),
    ).toEqual([1, 1]);

    let call = 0;
    installFetchMock(async () => {
      call += 1;
      return jsonResponse({
        translations: [
          {
            detected_source_language: "EN",
            text: call === 1 ? "Erste" : "Zweite",
          },
        ],
      });
    });

    expect(
      await translateTextBatches({
        apiKey: "deepl-key",
        texts,
        targetLang: "DE",
      }),
    ).toEqual(["Erste", "Zweite"]);
    expect(call).toBe(2);
  });

  test("partitions every request at the provider's item-count limit", () => {
    const texts = Array.from(
      { length: DEEPL_TEXT_REQUEST_MAX_ITEMS * 3 + 1 },
      (_, index) => `comment-${String(index)}`,
    );
    const batches = partitionDeepLTextBatches({ texts, targetLang: "DE" });

    expect(batches.map((batch) => batch.length)).toEqual([50, 50, 50, 1]);
    expect(batches.flat()).toEqual(texts);
    expect(
      batches.every((batch) => batch.length <= DEEPL_TEXT_REQUEST_MAX_ITEMS),
    ).toBeTrue();
  });

  test("rejects too many text entries before sending them", async () => {
    let called = false;
    installFetchMock(async () => {
      called = true;
      return jsonResponse({ translations: [] });
    });

    const resultError = await translateTextBatch({
      apiKey: "deepl-key",
      texts: Array.from(
        { length: DEEPL_TEXT_REQUEST_MAX_ITEMS + 1 },
        () => "comment",
      ),
      targetLang: "DE",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(DeepLDocumentError.is(resultError)).toBeTrue();
    expect(called).toBeFalse();
  });

  test("rejects an oversized request before sending it", async () => {
    let called = false;
    installFetchMock(async () => {
      called = true;
      return jsonResponse({ translations: [] });
    });

    const resultError = await translateTextBatch({
      apiKey: "deepl-key",
      texts: ["x".repeat(DEEPL_TEXT_REQUEST_MAX_BYTES)],
      targetLang: "DE",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(DeepLDocumentError.is(resultError)).toBeTrue();
    expect(called).toBeFalse();
  });
});
