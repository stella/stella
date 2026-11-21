import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("distinguishes imported useEditor from a parameter", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import { useEditor as editor } from "@tiptap/react";\nfunction local(editor) { editor({ extensions: [] }); }\neditor({ extensions: [] });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported useEditor from a destructured parameter", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import { useEditor as editor } from "@tiptap/react";\nfunction local({ editor }) { editor({ extensions: [] }); }\neditor({ extensions: [] });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported useEditor from a block binding", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import { useEditor as editor } from "@tiptap/react";\n{ const editor = unrelated; editor({ extensions: [] }); }\neditor({ extensions: [] });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported useEditor from a local binding", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import { useEditor as editor } from "@tiptap/react";\nfunction local() { const editor = unrelated; editor({ extensions: [] }); }\neditor({ extensions: [] });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported useEditor from a hoisted function", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import { useEditor as editor } from "@tiptap/react";\nfunction local() { editor({ extensions: [] }); function editor(options) { return options; } }\neditor({ extensions: [] });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported useEditor from a hoisted var", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import { useEditor as editor } from "@tiptap/react";\nfunction local() { editor({ extensions: [] }); var editor = unrelated; }\neditor({ extensions: [] });',
    ),
  ).toEqual([3]);
});

test("distinguishes namespace useEditor calls from a shadowed namespace", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import * as tiptap from "@tiptap/react";\nfunction local(tiptap) { tiptap.useEditor({ extensions: [] }); }\ntiptap.useEditor({ extensions: [] });',
    ),
  ).toEqual([3]);
});

test("follows stable factory aliases and namespace destructuring", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import * as tiptap from "@tiptap/react";\nconst { useEditor: create } = tiptap;\nconst alias = create;\nalias({ extensions: [] });\ntiptap["useEditor"]({ editorProps: {} });',
    ),
  ).toEqual([4, 5]);
});

test("preserves genuine fresh identity and local option reports", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import { useEditor } from "@tiptap/react";\nfunction Component() {\nconst extensions = [];\nuseEditor({ extensions, editorProps: {}, content: toDoc(value) });\n}',
    ),
  ).toEqual([4, 4, 4]);
});

test("preserves captured identities primitives and event-handler exemptions", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import { useEditor } from "@tiptap/react";\nconst extensions = [];\nfunction Component() {\nconst editorProps = useMemo(() => ({}), []);\nuseEditor({ extensions, editorProps, immediatelyRender: false, onUpdate: () => update() });\n}',
    ),
  ).toEqual([]);
});

test("does not treat same-named imports from another editor as Tiptap", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      'import { useEditor } from "other-editor";\nuseEditor({ extensions: [] });',
    ),
  ).toEqual([]);
});

test("does not inspect an outer initializer hidden by an options parameter", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      [
        'import { useEditor } from "@tiptap/react";',
        "function Outer() {",
        "const editorProps = {};",
        "function Nested(editorProps) { useEditor({ editorProps }); }",
        "useEditor({ editorProps });",
        "}",
      ].join("\n"),
    ),
  ).toEqual([5]);
});

test("does not inspect an outer initializer hidden by a block-local options binding", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      [
        'import { useEditor } from "@tiptap/react";',
        "function Component() {",
        "const extensions = [];",
        "{ const extensions = provided; useEditor({ extensions }); }",
        "useEditor({ extensions });",
        "}",
      ].join("\n"),
    ),
  ).toEqual([5]);
});

test("keeps actual closure options checked and nested-statement or alias values opaque", async () => {
  expect(
    await lintSingleRule(
      "require-stable-editor-options",
      [
        'import { useEditor } from "@tiptap/react";',
        "function Outer() {",
        "const editorProps = {};",
        "function Nested() { useEditor({ editorProps }); }",
        "const alias = editorProps;",
        "useEditor({ editorProps: alias });",
        "{ const extensions = []; useEditor({ extensions }); }",
        "}",
      ].join("\n"),
    ),
  ).toEqual([4]);
});
