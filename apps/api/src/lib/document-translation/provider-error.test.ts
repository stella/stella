import { expect, test } from "bun:test";

import { DeepLTimeoutError, DeepLUpstreamError } from "@/api/lib/deepl/errors";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { documentTranslationProviderErrorCode } from "./provider-error";

test("preserves a provider 503 as a durable availability failure", () => {
  const providerError = Object.assign(new Error("high demand"), {
    statusCode: 503,
  });

  expect(documentTranslationProviderErrorCode(providerError)).toBe(
    "provider_unavailable",
  );
});

test("does not present a missing provider model as a transient outage", () => {
  const providerError = Object.assign(new Error("model not found"), {
    statusCode: 404,
  });

  expect(documentTranslationProviderErrorCode(providerError)).toBe(
    "translation_failed",
  );
});

test("preserves a provider cause through the TanStack transport wrapper", () => {
  const providerError = new HandlerError({
    cause: Object.assign(new Error("model not found"), { statusCode: 404 }),
    message: "provider request failed",
    status: 502,
  });

  expect(documentTranslationProviderErrorCode(providerError)).toBe(
    "translation_failed",
  );
});

test("preserves DeepL upstream outages as availability failures", () => {
  const providerError = new DeepLUpstreamError({
    httpStatus: 503,
    message: "DeepL is unavailable",
  });

  expect(documentTranslationProviderErrorCode(providerError)).toBe(
    "provider_unavailable",
  );
});

test("preserves DeepL polling timeouts as availability failures", () => {
  const providerError = new DeepLTimeoutError({
    documentId: "document-id",
    elapsedMs: 1,
    message: "DeepL timed out",
  });

  expect(documentTranslationProviderErrorCode(providerError)).toBe(
    "provider_unavailable",
  );
});
