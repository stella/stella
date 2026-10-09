import { expect, test } from "bun:test";

import { rewriteUnicodeNormalization } from "./codemod-unicode-normalize";

test("rewrites supported forms and leaves unrelated normalize calls alone", () => {
  const source = `import path from "node:path";\nconst a = text.normalize("NFC");\nconst b = path.normalize(text);\n`;

  expect(rewriteUnicodeNormalization(source)).toBe(
    `import { normalizeUnicode } from "@stll/text-normalize";\n\nimport path from "node:path";\nconst a = normalizeUnicode(text, "NFC");\nconst b = path.normalize(text);\n`,
  );
});

test("rewrites chained normalization without overlapping edits", () => {
  const source = `const key = value.normalize("NFKC").trim().normalize("NFKD");\n`;

  expect(rewriteUnicodeNormalization(source)).toBe(
    `import { normalizeUnicode } from "@stll/text-normalize";\n\nconst key = normalizeUnicode(normalizeUnicode(value, "NFKC").trim(), "NFKD");\n`,
  );
});
