import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects every native normalization form shape", async () => {
  const source = [
    "text.normalize();",
    'text.normalize("NFC");',
    'text.normalize("NFD");',
    'text.normalize("NFKC");',
    'text.normalize("NFKD");',
    "text.normalize(form);",
    "text.normalize(options.form);",
    "text.normalize(getForm());",
    'text["normalize"](getForm());',
  ].join("\n");
  expect(await lintSingleRule("no-direct-unicode-normalize", source)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
});

test("rejects each owned mark class with and without the unicode flag", async () => {
  const source = [
    'text.replace(/\\p{M}/gu, "");',
    'text.replaceAll(/\\p{M}+/g, "");',
    'text.replace(/\\p{Mn}/u, "");',
    'text.replaceAll(/\\p{Mn}+/g, "");',
    'text.replace(/\\p{Diacritic}/gu, "");',
    'text.replaceAll(/\\p{Diacritic}+/g, "");',
    'text.replace(/[\\u0300-\\u036f]/gu, "");',
    'text.replaceAll(/[̀-ͯ]+/g, "");',
  ].join("\n");
  expect(await lintSingleRule("no-direct-unicode-normalize", source)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);
});

test("accepts owner calls, Node path normalization, and non-removal regex uses", async () => {
  const source = [
    'import path from "node:path";',
    'import * as posixPath from "node:path/posix";',
    'normalizeUnicode(text, "NFC");',
    'stripUnicodeMarks(text, { form: "NFD", markClass: "combining" });',
    "stripDiacritics(text);",
    "path.normalize(file);",
    "path.posix.normalize(file);",
    "posixPath.normalize(file);",
    "({ normalize: (value) => value }).normalize(1);",
    "/\\p{M}/u.test(text);",
    "text.split(/[̀-ͯ]/u);",
  ].join("\n");
  expect(await lintSingleRule("no-direct-unicode-normalize", source)).toEqual(
    [],
  );
});

test("allows the text-normalize owner to call the native primitive", async () => {
  expect(
    await lintSingleRule(
      "no-direct-unicode-normalize",
      'export const normalize = (text) => text.normalize("NFC");',
      { sourcePath: "packages/text-normalize/src/native.ts" },
    ),
  ).toEqual([]);
});
