import { describe, expect, test } from "bun:test";

import {
  formatAppError,
  LocalizedAppError,
  type AppMessageDescriptor,
} from "./app-error";
import { appLocale } from "./locale";

describe("MCP app host locales", () => {
  test.each([
    ["cs-CZ", "cs", "Dokument 123"],
    ["sk-SK", "sk", "Dokument 123"],
    ["en-GB", "en", "Document 123"],
  ] as const)(
    "regional host locale %s selects catalog %s",
    (hostLocale, expected, documentLabel) => {
      const locale = appLocale(hostLocale);
      expect(locale.locale).toBe(expected);
      expect(locale.formattingLocale).toBe(hostLocale);
      expect(locale.t("comparisonTitle")).toBe(locale.messages.comparisonTitle);
      expect(locale.t("documentTarget", { documentId: "123" })).toBe(
        documentLabel,
      );
    },
  );

  test.each([undefined, "invalid_locale!", "ja-JP"])(
    "missing, malformed and unsupported host locales use English: %s",
    (hostLocale) => {
      const locale = appLocale(hostLocale);
      expect(locale.locale).toBe("en");
      expect(locale.t("comparisonTitle")).toBe("Compare two files");
    },
  );
});

describe("MCP app error locale changes", () => {
  test.each([
    { key: "invalidComparisonReservation" },
    { key: "invalidUploadHeaders" },
    { key: "uploadFailed" },
    { key: "storageRejected", values: { status: 403 } },
    { key: "capabilityFailed", values: { capability: "test_upload" } },
  ] satisfies AppMessageDescriptor[])(
    "displayed $key errors follow the current host locale",
    (descriptor) => {
      let locale = appLocale("en");
      const error = new LocalizedAppError(descriptor);
      const status = () => formatAppError(error, locale.t, "uploadFailed");
      const english = status();
      for (const hostLocale of ["cs-CZ", "ar", "en-GB"]) {
        locale = appLocale(hostLocale);
        const expected = locale.t(descriptor.key, descriptor.values);
        if (locale.locale !== "en") {
          expect(expected).not.toBe(english);
        }
        expect(status()).toBe(expected);
      }
    },
  );

  test("fallback and cleanup errors are formatted after locale changes", () => {
    let locale = appLocale("en");
    const status = () =>
      locale.t("uploadCleanupFailed", {
        message: formatAppError(undefined, locale.t, "uploadFailed"),
        cleanupMessage: formatAppError(undefined, locale.t, "cleanupFailed"),
      });
    const english = status();
    locale = appLocale("cs-CZ");
    expect(status()).not.toBe(english);
    expect(status()).toBe(
      locale.t("uploadCleanupFailed", {
        message: locale.t("uploadFailed"),
        cleanupMessage: locale.t("cleanupFailed"),
      }),
    );
    expect(
      formatAppError(new Error("External failure"), locale.t, "uploadFailed"),
    ).toBe("External failure");
  });
});
