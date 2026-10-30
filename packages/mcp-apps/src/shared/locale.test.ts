import { describe, expect, test } from "bun:test";

import {
  type AppMessageDescriptor,
  formatAppError,
  LocalizedAppError,
} from "./app-error";
import { appLocale, setAppDocumentLocale } from "./locale";

const browser = { documentLanguage: "sk-SK", navigatorLanguages: ["cs-CZ"] };

test("host locale wins and retains regional numbering preferences", () => {
  expect(appLocale("ar-EG-u-nu-arab", browser)).toMatchObject({
    source: "host",
    locale: "ar",
    formattingLocale: "ar-EG-u-nu-arab",
    direction: "rtl",
  });
});

test("document language wins when the host does not send a locale", () => {
  expect(appLocale(undefined, browser)).toMatchObject({
    source: "document",
    locale: "sk",
  });
});

test("navigator language supplies Czech UI when host and document have no locale", () => {
  expect(
    appLocale(undefined, {
      documentLanguage: "",
      navigatorLanguages: ["cs-CZ"],
    }),
  ).toMatchObject({
    source: "navigator",
    locale: "cs",
    formattingLocale: "cs-CZ",
  });
});

test("invalid and unshipped language candidates fall through to a supported browser language", () => {
  expect(
    appLocale("invalid-locale-value", {
      documentLanguage: "zz",
      navigatorLanguages: ["zz", "sk-SK"],
    }),
  ).toMatchObject({
    source: "navigator",
    locale: "sk",
  });
});

test("source language is the final fallback when every supplied language is unusable", () => {
  expect(
    appLocale(undefined, {
      documentLanguage: undefined,
      navigatorLanguages: [],
    }),
  ).toMatchObject({
    source: "default",
    locale: "en",
    formattingLocale: "en",
  });
});

test("resolved locale updates the document language, direction and localized title", () => {
  const previous = {
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    title: document.title,
  };
  const locale = setAppDocumentLocale("cs-CZ");
  expect(document.documentElement.lang).toBe("cs-CZ");
  expect(document.documentElement.dir).toBe("ltr");
  expect(document.title).toBe(locale.messages.title);
  setAppDocumentLocale("ar", "قارئ القرار");
  expect(document.documentElement.dir).toBe("rtl");
  expect(document.title).toBe("قارئ القرار");
  document.documentElement.lang = previous.lang;
  document.documentElement.dir = previous.dir;
  document.title = previous.title;
});

describe("MCP app host locales", () => {
  test.each([
    ["cs-CZ", "cs", "Dokument 123"],
    ["sk-SK", "sk", "Dokument 123"],
    ["en-GB", "en", "Document 123"],
  ] as const)(
    "regional host locale %s selects catalog %s",
    (hostLocale, expected, documentLabel) => {
      const locale = appLocale(hostLocale, {
        documentLanguage: undefined,
        navigatorLanguages: [],
      });
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
      const locale = appLocale(hostLocale, {
        documentLanguage: undefined,
        navigatorLanguages: [],
      });
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
        locale = appLocale(hostLocale, {
          documentLanguage: undefined,
          navigatorLanguages: [],
        });
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
