import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects missing and base language locales across number and date formatters", async () => {
  expect(
    await lintSingleRule(
      "no-raw-locale-format",
      [
        "new Intl.NumberFormat();",
        'new Intl.DateTimeFormat("en-US");',
        "new Intl.RelativeTimeFormat(lang);",
        "date.toLocaleString();",
        "date.toLocaleDateString(undefined, options);",
        'date.toLocaleTimeString("ar", options);',
        "number.toLocaleString(lang);",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test("allows full preference locales and central formatting helpers", async () => {
  expect(
    await lintSingleRule(
      "no-raw-locale-format",
      [
        "new Intl.NumberFormat(getFormattingLocale());",
        "new Intl.DateTimeFormat(locale, options);",
        "new Intl.RelativeTimeFormat(getFormattingLocale(), options);",
        "date.toLocaleString(locale);",
        "date.toLocaleDateString(getFormattingLocale(), options);",
        "date.toLocaleTimeString(locale, options);",
        "getFormatter().number(value);",
      ].join("\n"),
    ),
  ).toEqual([]);
});
