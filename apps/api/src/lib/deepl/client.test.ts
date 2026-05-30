import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DeepLDocumentError, DeepLUpstreamError } from "@/api/lib/deepl/errors";

import { translateDocument } from "./client";

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
