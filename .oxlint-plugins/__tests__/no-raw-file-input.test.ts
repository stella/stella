import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects visible and hidden browser file inputs", async () => {
  expect(
    await lintSingleRule(
      "no-raw-file-input",
      'const visible = <input type="file" />;\nconst hidden = <input className="hidden" ref={inputRef} type="file" />;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1, 2]);
});

test("rejects literal-expression file input types", async () => {
  expect(
    await lintSingleRule(
      "no-raw-file-input",
      'const input = <input type={"file"} />;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});

test("accepts non-file and dynamic input types", async () => {
  expect(
    await lintSingleRule(
      "no-raw-file-input",
      'const text = <input type="text" />;\nconst dynamic = <input type={inputType} />;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("accepts the owned field and handler picker", async () => {
  expect(
    await lintSingleRule(
      "no-raw-file-input",
      'const field = <FileInput label="Upload" />;\nopenFilePicker();\ndocument.createElement("input");',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});
