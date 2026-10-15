import { expect, test } from "bun:test";

import { lintRuleAcrossFiles, lintSingleRule } from "./lint-single-rule.ts";

test("rejects every zip entry write outside the owner", async () => {
  const source = [
    'zip.file("word/document.xml", xml);',
    'zip.file(path, bytes, { compression: "STORE" });',
    "archive.zip.file(path, stripped);",
    'zip.folder("word").file("a.xml", text);',
    'zip["file"](path, text);',
    "getZip().file(path, text);",
  ].join("\n");
  expect(await lintSingleRule("no-string-zip-entry", source)).toEqual([
    1, 2, 3, 4, 5, 6,
  ]);
});

test("accepts reads, Bun.file, file-entry callbacks, and owner calls", async () => {
  const source = [
    'zip.file("word/document.xml");',
    "zip.file(/^word\\//u);",
    "Bun.file(path);",
    'Bun.file(path, { type: "text/plain" });',
    'writeZipEntry(zip, "word/document.xml", xml);',
    "entry.file(resolve, (error) => reject(error));",
    "entry.file(function (file) {}, onError);",
  ].join("\n");
  expect(await lintSingleRule("no-string-zip-entry", source)).toEqual([]);
});

test("allows the owner module and resets between files", async () => {
  expect(
    await lintRuleAcrossFiles("no-string-zip-entry", {
      "packages/docx-utils/src/zip-entry.ts": "zip.file(path, data, options);",
      "z-consumer.ts": 'zip.file("a.xml", text);',
    }),
  ).toEqual({
    "packages/docx-utils/src/zip-entry.ts": [],
    "z-consumer.ts": [1],
  });
});
