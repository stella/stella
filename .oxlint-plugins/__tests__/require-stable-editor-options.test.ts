import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects fresh inline option identities through imported aliases", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import { useEditor as editor } from "@tiptap/react";\nfunction Component() {\neditor({ extensions: [], editorProps: {}, content: convert(value), editable: () => true });\neditor({ content: condition ? [] : initial });\neditor({ content: fallback || {} });\n}',
    ),
  ).toEqual([3, 3, 3, 3, 4, 5]);
});

test("rejects fresh same-function bindings", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import { useEditor } from "@tiptap/react";\nfunction Component() {\nconst extensions = [];\nconst editorProps = {};\nuseEditor({ extensions, editorProps });\n}',
    ),
  ).toEqual([5, 5]);
});

test("accepts module constants hook-captured values primitives and event handlers", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import { useEditor } from "@tiptap/react";\nconst extensions = [];\nfunction Component() {\nconst editorProps = useMemo(() => ({}), []);\nconst [content] = useState(() => convert(value));\nuseEditor({ extensions, editorProps, content, immediatelyRender: false, onUpdate: () => update() });\n}',
    ),
  ).toEqual([]);
});

test("does not treat unrelated editor factories as Tiptap bindings", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import { useEditor } from "other-editor";\nuseEditor({ extensions: [] });',
    ),
  ).toEqual([]);
});
