import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("no-inline-heavy-host-props", () => {
  test("reports object, array, and JSX literals on heavy hosts", async () => {
    expect(
      await lintSingleRule(
        "no-inline-heavy-host-props",
        `const view = <><FileTabViewer display={{ active: true }} /><DocxEditorSlot resetKeys={[id]} fallback={<Loading />} /></>;`,
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([1, 1, 1]);
  });

  test("accepts stable identifiers and unrelated components", async () => {
    expect(
      await lintSingleRule(
        "no-inline-heavy-host-props",
        `const view = <><FileTabViewer display={display} /><Small display={{ active: true }} /></>;`,
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([]);
  });
});
