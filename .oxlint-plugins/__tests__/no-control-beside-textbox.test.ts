import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-control-beside-textbox";
const lint = (source: string, ruleOptions?: unknown) =>
  lintSingleRule(RULE, source, {
    sourcePath: "source.tsx",
    ...(ruleOptions === undefined ? {} : { ruleOptions }),
  });

test("rejects the compact composer row: text cell between its controls", async () => {
  // The shape the chat bar had: a three-column grid, the editor in the middle
  // cell behind a provider, the (+) menu and send beside it.
  expect(
    await lint(`const GRID = "grid grid-cols-[auto_minmax(0,1fr)_auto] items-end";
const bar = (
  <div className={cn(GRID, "gap-1")}>
    <div className="min-w-0 py-[11px]">
      <ReferenceRenderScope>
        <PromptEditorContent editor={editor} />
      </ReferenceRenderScope>
    </div>
    <div className="contents">
      <span><ComposerPlusMenu /></span>
      <span><ChatComposerActionButton /></span>
    </div>
  </div>
);`),
  ).toEqual([6]);
});

test("rejects every textbox kind beside a control in a flex row", async () => {
  expect(
    await lint(`const a = <div className="flex"><textarea /><button /></div>;
const b = <div className="inline-flex"><Textarea /><Button /></div>;
const c = <div className="flex flex-row"><EditorContent /><SendButton /></div>;
const d = <div className="flex"><div contentEditable /><MenuTrigger /></div>;
const e = <div className="grid-flow-col grid"><Textarea /><Button /></div>;`),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("rejects a control positioned over the text", async () => {
  expect(
    await lint(`const a = (
  <div className="relative">
    <Textarea />
    <div className="absolute end-1 bottom-1"><Button /></div>
  </div>
);`),
  ).toEqual([3]);
});

test("accepts the text over a control row and a textbox handed to a frame", async () => {
  expect(
    await lint(`const a = (
  <div className="flex flex-col">
    <Textarea />
    <div className="flex justify-end"><Button /></div>
  </div>
);
const b = <ComposerFrame text={<PromptEditorContent />} trailing={<Button />} />;
const c = <div className="grid"><Textarea /><Button /></div>;
const d = <div className="grid grid-cols-1"><Textarea /><Button /></div>;`),
  ).toEqual([]);
});

test("stops at a column, a popup, and an anchor outside the box", async () => {
  expect(
    await lint(`const header = (
  <div className="flex items-start gap-4">
    <div className="flex flex-1 flex-col"><Textarea /></div>
    <Button />
  </div>
);
const dialogs = (
  <div className="flex flex-wrap">
    <DialogPopup><Textarea /></DialogPopup>
    <Button />
  </div>
);
const presets = (
  <div className="relative">
    <div className="absolute bottom-full"><Button /></div>
    <Textarea />
  </div>
);`),
  ).toEqual([]);
});

test("a select beside a textarea is a field beside a field", async () => {
  expect(
    await lint(
      'const form = <div className="flex"><SelectTrigger /><Textarea /></div>;',
    ),
  ).toEqual([]);
});

test("reads configured textboxes and controls", async () => {
  expect(
    await lint(
      `const a = <div className="flex"><NoteEditor /><Chip /></div>;
const b = <div className="flex"><Textarea /><Chip /></div>;`,
      { textboxComponents: ["NoteEditor"], controlComponents: ["Chip"] },
    ),
  ).toEqual([1, 2]);
});
