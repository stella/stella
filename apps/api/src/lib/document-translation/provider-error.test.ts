import { expect, test } from "bun:test";

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
