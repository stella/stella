import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-adhoc-textbox-growth";
const lint = async (source: string) =>
  lintSingleRule(RULE, source, { sourcePath: "source.tsx" });

test("rejects the hand-set caps the composers carried", async () => {
  // The chat editor's own attributes, the docked bar's editor cell and the
  // Outlook assistant's textarea, as they were written.
  expect(
    await lint(`const editorProps = {
  attributes: () => ({
    class: "field-sizing-content max-h-48 min-h-10 overflow-y-auto text-sm",
  }),
};
const bar = <PromptEditorContent className="folio-ai-bar-editor [&_.ProseMirror]:max-h-32 [&_.ProseMirror]:overflow-y-auto" />;
const ask = <Textarea className={cn("block w-full [&_textarea]:max-h-48 [&_textarea]:min-h-15")} unstyled />;`),
  ).toEqual([3, 6, 7]);
});

test("rejects a cap on a textarea's className and in an editor's attributes", async () => {
  expect(
    await lint(`const a = <Textarea className="max-h-40" />;
const b = <textarea className={cn("w-full", "max-h-[12rem]")} />;
const c = { attributes: { class: "overflow-y-auto text-sm" } };`),
  ).toEqual([1, 2, 3]);
});

test("rejects every textbox selector under any combinator", async () => {
  expect(
    await lint(`const a = "[&>.tiptap]:max-h-20";
const b = "[&_[contenteditable]]:overflow-auto";
const c = "[&_[role=textbox]]:max-h-60";
const d = "[&_.ProseMirror:focus]:overflow-y-scroll";
const e = "md:field-sizing-content";
const f = "[&_.ProseMirror:hover]:max-h-64";
const g = "[&>textarea:focus-visible]:overflow-y-auto";`),
  ).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test("reads template literal chunks like string literals", async () => {
  expect(
    await lint(`const cls = \`field-sizing-content\`;
const bar = <PromptEditorContent className={\`\${base} [&_.ProseMirror]:max-h-32\`} />;
const ask = <Textarea className={\`w-full max-h-40\`} />;
const editorProps = { attributes: { class: \`overflow-y-auto text-sm\` } };
const ok = \`[&_.ProseMirror]:min-h-15 \${tone}\`;`),
  ).toEqual([1, 2, 3, 4]);
});

test("accepts floors, typography, content inside the editor and other chrome", async () => {
  expect(
    await lint(`const a = "[&_.ProseMirror]:min-h-15 [&_.ProseMirror]:leading-5";
const b = "[&_.ProseMirror_pre]:max-h-64 [&_.ProseMirror_pre]:overflow-x-auto";
const c = <div className="max-h-80 overflow-y-auto" />;
const d = <Input className="max-h-9" />;
const e = { class: "max-h-48", attributes: { role: "textbox" } };
const f = { attributes: { class: "min-h-10 text-sm" } };
const g = "[&_.ProseMirror]:overflow-hidden";
const h = "[&_.ProseMirror:hover_pre]:max-h-64 [&_.ProseMirror:focus>pre]:overflow-x-auto";`),
  ).toEqual([]);
});
