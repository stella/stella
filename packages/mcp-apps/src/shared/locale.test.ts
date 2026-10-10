import { expect, test } from "bun:test";

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
