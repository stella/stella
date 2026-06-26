import { describe, expect, test } from "bun:test";

import { suppressHiddenEditorScrollToSelection } from "./hiddenEditorScroll";

describe("hidden editor scroll handling", () => {
  test("claims selection scrolling so ProseMirror does not move visible ancestors", () => {
    expect(suppressHiddenEditorScrollToSelection()).toBe(true);
  });
});
