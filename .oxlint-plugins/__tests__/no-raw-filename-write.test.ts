import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("reports raw request filename fields at write boundaries", async () => {
  expect(
    await lintSingleRule(
      "no-raw-filename-write",
      "const row = { fileName: body.fileName };\nrow.filename = file.name;",
      {
        plugin: "security-guards",
        sourcePath: "apps/api/src/handlers/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([1, 2]);
});

test("tracks destructured request aliases and filename transformations", async () => {
  expect(
    await lintSingleRule(
      "no-raw-filename-write",
      "function write({ body }) { const { fileName: name } = body; const row = { fileName: name.trim() }; }",
      {
        plugin: "security-guards",
        sourcePath: "apps/api/src/handlers/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([1]);
});

test("accepts the canonical filename sanitizer and its import alias", async () => {
  expect(
    await lintSingleRule(
      "no-raw-filename-write",
      'import { sanitizeFilename as clean } from "@/api/lib/sanitize-filename";\nconst row = { fileName: clean(body.fileName) };',
      {
        plugin: "security-guards",
        sourcePath: "apps/api/src/handlers/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});

test("does not trust a same named foreign sanitizer", async () => {
  expect(
    await lintSingleRule(
      "no-raw-filename-write",
      'import { sanitizeFilename } from "./other";\nconst row = { fileName: sanitizeFilename(body.fileName) };',
      {
        plugin: "security-guards",
        sourcePath: "apps/api/src/handlers/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([2]);
});

test("allows stored and literal filename values", async () => {
  expect(
    await lintSingleRule(
      "no-raw-filename-write",
      'const row = { fileName: content.fileName };\nconst select = { fileName: true };\nconst literal = { fileName: "document.pdf" };',
      {
        plugin: "security-guards",
        sourcePath: "apps/api/src/handlers/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});

test("requires the actual canonical filename sanitizer binding", async () => {
  expect(
    await lintSingleRule(
      "no-raw-filename-write",
      `import { sanitizeFilename } from "@/api/lib/sanitize-filename";
function write(sanitizeFilename) { return { fileName: sanitizeFilename(body.fileName) }; }`,
      {
        plugin: "security-guards",
        sourcePath: "apps/api/src/handlers/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([2]);
});
