import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("require-file-transport-disposition", () => {
  test("reports catalog file handlers without transport", async () => {
    expect(
      await lintSingleRule(
        "require-file-transport-disposition",
        'const body = t.Object({ file: t.File() });\nconst config = { body, mcp: { type: "capability" } } satisfies HandlerConfig;',
      ),
    ).toEqual([2]);
  });
  test("reports blob fields in session handlers", async () => {
    expect(
      await lintSingleRule(
        "require-file-transport-disposition",
        "const body = t.Object({ bytes: t.Blob() });\nconst config = { body } satisfies SessionHandlerConfig;",
      ),
    ).toEqual([2]);
  });
  test("accepts explicit transport declarations", async () => {
    expect(
      await lintSingleRule(
        "require-file-transport-disposition",
        'const body = t.Object({ file: t.Files() });\nconst config = { body, transport: { type: "file-input" } } satisfies HandlerConfig;',
      ),
    ).toEqual([]);
  });
  test("accepts internal handlers", async () => {
    expect(
      await lintSingleRule(
        "require-file-transport-disposition",
        'const body = t.Object({ file: t.File() });\nconst config = { body, mcp: { type: "internal", reason: "service only" } } satisfies HandlerConfig;',
      ),
    ).toEqual([]);
  });
});
