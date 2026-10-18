import { expect, test } from "bun:test";

import { getLiveEditor } from "./live-editor";

test("editor access follows teardown across retained references", () => {
  const editor = { isDestroyed: false };
  const retained = editor;
  expect(getLiveEditor(editor)).toBe(editor);
  expect(getLiveEditor(retained)).toBe(editor);

  editor.isDestroyed = true;
  expect(getLiveEditor(editor)).toBeNull();
  expect(getLiveEditor(retained)).toBeNull();
  expect(getLiveEditor(null)).toBeNull();
  expect(getLiveEditor(undefined)).toBeNull();
});
