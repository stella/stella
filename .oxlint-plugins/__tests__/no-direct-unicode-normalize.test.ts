import { expect, test } from "bun:test";

import { lintRuleAcrossFiles, lintSingleRule } from "./lint-single-rule.ts";

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
    "text.replace(/\\p{M}/gu, ``);",
  ].join("\n");
  expect(await lintSingleRule("no-direct-unicode-normalize", source)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
});

test("rejects hand-rolled slug runs, ASCII and Unicode, either separator", async () => {
  const source = [
    'text.replace(/[^a-z0-9]+/gu, "-");',
    'text.replaceAll(/[^a-z0-9]+/g, "-");',
    'text.replace(/[^\\da-z]+/gu, "-");',
    'text.replace(/[^a-z0-9-]+/gu, "-");',
    'text.replace(/[^a-z0-9_]+/gu, "_");',
    'text.replace(/[^\\p{L}\\p{N}]+/gu, "-");',
  ].join("\n");
  expect(await lintSingleRule("no-direct-unicode-normalize", source)).toEqual([
    1, 2, 3, 4, 5, 6,
  ]);
});

test("accepts other character classes, non-separator replacements and slugify", async () => {
  const source = [
    'slugify(text, { charset: "ascii", separator: "-", maxLength: 60, fallback: "" });',
    'text.replace(/[^a-z0-9.]+/gu, "-");',
    'text.replace(/[^a-z0-9]/gu, "-");',
    'text.replace(/[^a-z0-9]+/gu, " ");',
    'text.replace(/[^a-z0-9]+/gu, "");',
    'text.replace(/[^\\p{L}\\p{N}.]+/gu, "_");',
    "text.replace(/[^a-z0-9]+/gu, separator);",
  ].join("\n");
  expect(await lintSingleRule("no-direct-unicode-normalize", source)).toEqual(
    [],
  );
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
    'text.replace(/\\p{M}/gu, "-");',
    "text.replaceAll(/\\p{Mn}+/g, (mark) => mark.toUpperCase());",
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

test("resets owner exclusions and Node path bindings between files", async () => {
  expect(
    await lintRuleAcrossFiles("no-direct-unicode-normalize", {
      "a-path.ts": 'import path from "node:path"; path.normalize(file);',
      "packages/text-normalize/src/native.ts": 'text.normalize("NFC");',
      "z-consumer.ts":
        'const path = "text";\npath.normalize();\ntext.normalize("NFC");',
    }),
  ).toEqual({
    "a-path.ts": [],
    "packages/text-normalize/src/native.ts": [],
    "z-consumer.ts": [2, 3],
  });
});
