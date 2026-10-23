import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("require-file-transport-disposition", () => {
  test("reports catalog file handlers without transport", async () => {
    expect(
      await lintSingleRule(
        "require-file-transport-disposition",
        'const body = v.object({ file: fileSchema({ maxBytes: 5 }) });\nconst config = { body, mcp: { type: "capability" } } satisfies HandlerConfig;',
      ),
    ).toEqual([2]);
  });
  test("reports blob fields in workspace and session handlers", async () => {
    expect(
      await lintSingleRule(
        "require-file-transport-disposition",
        "const body = v.object({ bytes: v.blob() });\nconst a = { body } satisfies SessionHandlerConfig;\nconst b = { body } satisfies WorkspaceHandlerConfig;",
      ),
    ).toEqual([2, 3]);
  });
  test("reports a config passed inline to a safe-handler factory", async () => {
    expect(
      await lintSingleRule(
        "require-file-transport-disposition",
        [
          "const body = v.object({ file: v.pipe(v.file(), v.maxSize(5)) });",
          'export default createSafeRootHandler({ body, mcp: { type: "capability" } }, run);',
          "export const subject = createSafePublicSubjectHandler({ config: { body }, handler: run });",
        ].join("\n"),
      ),
    ).toEqual([2, 3]);
  });
  test("accepts explicit transport declarations", async () => {
    expect(
      await lintSingleRule(
        "require-file-transport-disposition",
        'const body = v.object({ file: fileSchema({ maxBytes: 5 }) });\nconst config = { body, transport: { type: "file-input" } } satisfies HandlerConfig;\nexport default createSafeRootHandler(config, run);',
      ),
    ).toEqual([]);
  });
  test("accepts internal handlers", async () => {
    expect(
      await lintSingleRule(
        "require-file-transport-disposition",
        'const body = v.object({ file: v.file() });\nconst config = { body, mcp: { type: "internal", reason: "service only" } } satisfies HandlerConfig;',
      ),
    ).toEqual([]);
  });
  test("ignores configs in modules without a file field", async () => {
    expect(
      await lintSingleRule(
        "require-file-transport-disposition",
        'const body = v.object({ name: v.string() });\nexport default createSafeRootHandler({ body, mcp: { type: "capability" } }, run);',
      ),
    ).toEqual([]);
  });
});
