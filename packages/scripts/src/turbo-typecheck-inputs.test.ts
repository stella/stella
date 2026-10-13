import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeTurboTypecheckInputs } from "./turbo-typecheck-inputs";

test("rewritten task inputs keep the surrounding indentation", () => {
  const filename = path.join(
    mkdtempSync(path.join(tmpdir(), "turbo-inputs-")),
    "turbo.json",
  );
  writeFileSync(
    filename,
    `{
  "tasks": {
    "@stll/api#typecheck:src": {
      "inputs": ["old"],
      "outputs": []
    }
  }
}
`,
  );

  writeTurboTypecheckInputs(
    filename,
    new Map([["@stll/api#typecheck:src", ["$TURBO_ROOT$/a/**", "src/**"]]]),
  );

  expect(readFileSync(filename, "utf-8")).toBe(`{
  "tasks": {
    "@stll/api#typecheck:src": {
      "inputs": [
        "$TURBO_ROOT$/a/**",
        "src/**"
      ],
      "outputs": []
    }
  }
}
`);
});
