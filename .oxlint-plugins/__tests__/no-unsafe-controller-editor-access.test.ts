import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = (source: string) =>
  lintSingleRule("no-unsafe-controller-editor-access", source, {
    cwd: "scratch",
    sourcePath: "apps/web/src/components/example.tsx",
  });
const imports =
  'import { useChatEditor as useEditor, type ChatEditorController as Controller } from "@/components/chat-editor-provider";';

test("requires live editor access for controller aliases and destructuring", async () => {
  expect(
    await lint(`${imports}
const controller = useEditor({});
const alias = controller;
alias.editor?.getText();
const { editor: draft } = alias;
draft?.commands.clearContent();
const direct = useEditor({}).editor;
const { getText } = direct;
const { editor: { commands } } = controller;
`),
  ).toEqual([4, 6, 8, 9]);
});

test("tracks imported controller types on parameters and destructured props", async () => {
  expect(
    await lint(`${imports}
function read(controller: Controller) { controller.editor?.getText(); }
function readEditor({ editor }: Controller) { editor?.commands.clearContent(); }
function readProps({ controller }: { controller: Controller }) { controller.editor?.getText(); }
`),
  ).toEqual([2, 3, 4]);
});

test("allows guarded handles and unrelated editors with lexical shadowing", async () => {
  expect(
    await lint(`${imports}
import { getLiveEditor as live } from "@/components/live-editor";
const controller = useEditor({});
const editor = live(controller.editor);
editor?.getText();
editor?.commands.clearContent();
function other(controller, useEditor) { controller.editor.getText(); useEditor().editor.commands.clearContent(); }
const unrelated = externalEditor;
unrelated.commands.clearContent();
`),
  ).toEqual([]);
});

test("resolves namespace and relative imports and computed properties", async () => {
  expect(
    await lint(
      'import * as chat from "./chat-editor-provider";\nconst { editor } = chat.useChatEditor({});\neditor["getText"]();\neditor["commands"].clearContent();',
    ),
  ).toEqual([3, 4]);
});

test("follows local props type aliases and interfaces", async () => {
  expect(
    await lint(`${imports}
type Props = { controller: Controller };
interface InterfaceProps { controller: Controller }
function alias({ controller }: Props) { controller.editor?.getText(); }
function iface({ controller }: InterfaceProps) { controller.editor?.commands.clearContent(); }
`),
  ).toEqual([4, 5]);
});
