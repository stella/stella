import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const PLUGIN = "copy-feedback-owner";
const LISTENER_RULE = "no-raw-copy-listener";
const WRITE_RULE = "no-raw-clipboard-write";
const OWNER = "apps/web/src/components/copy-control.tsx";
const CALLER = "apps/web/src/components/bar.tsx";

test("rejects a DOM copy listener and a JSX copy handler on an element", async () => {
  expect(
    await lintSingleRule(
      LISTENER_RULE,
      `declare const confirm: () => void;
declare const root: HTMLElement;
root.ownerDocument.addEventListener("copy", confirm);
document.addEventListener(\`copy\`, confirm, { capture: true });
window["addEventListener"]("copy", confirm);
export const a = <p onCopy={confirm} />;
export const b = <div onCopyCapture={confirm} />;`,
      { plugin: PLUGIN, sourcePath: CALLER },
    ),
  ).toEqual([3, 4, 5, 6, 7]);
});

test("accepts other events, a removal and a component's own onCopy prop", async () => {
  expect(
    await lintSingleRule(
      LISTENER_RULE,
      `declare const confirm: () => void;
declare const write: () => Promise<boolean>;
declare const root: HTMLElement;
declare const NoticeCopy: (props: { onCopy: () => Promise<boolean> }) => null;
root.addEventListener("selectionchange", confirm);
root.removeEventListener("copy", confirm);
export const c = <NoticeCopy onCopy={write} />;
export const d = <Copy.Button onCopy={write} />;`,
      { plugin: PLUGIN, sourcePath: CALLER },
    ),
  ).toEqual([]);
});

test("the copy listener owners may listen; any other file may not", async () => {
  const source = 'window.addEventListener("copy", () => {});';
  const [owner, transcript, caller] = await Promise.all([
    lintSingleRule(LISTENER_RULE, source, {
      plugin: PLUGIN,
      sourcePath: OWNER,
    }),
    lintSingleRule(LISTENER_RULE, source, {
      plugin: PLUGIN,
      sourcePath: "apps/web/src/components/chat/chat-transcript-copy.tsx",
    }),
    lintSingleRule(LISTENER_RULE, source, {
      plugin: PLUGIN,
      sourcePath: "apps/web/src/components/chat/chat-selection-toolbar.tsx",
    }),
  ]);
  expect(owner).toEqual([]);
  expect(transcript).toEqual([]);
  expect(caller).toEqual([1]);
});

test("rejects every way of reaching the browser clipboard", async () => {
  expect(
    await lintSingleRule(
      WRITE_RULE,
      `declare const root: HTMLElement;
await navigator.clipboard.writeText("Smlouva o dílo");
await window.navigator.clipboard.writeText("Smlouva o dílo");
await globalThis.navigator["clipboard"].write([]);
const clipboard: unknown = Reflect.get(navigator, "clipboard");
root.ownerDocument.execCommand("copy");
document.execCommand("cut");
export const item = new ClipboardItem({});
export { clipboard };`,
      { plugin: PLUGIN, sourcePath: CALLER },
    ),
  ).toEqual([2, 3, 4, 5, 6, 7, 8]);
});

test("accepts a paste read and other editing commands", async () => {
  expect(
    await lintSingleRule(
      WRITE_RULE,
      `declare const event: ClipboardEvent;
export const pasted = event.clipboardData?.getData("text/plain");
document.execCommand("bold");
declare const store: { clipboard: string };
export const local = store.clipboard;`,
      { plugin: PLUGIN, sourcePath: CALLER },
    ),
  ).toEqual([]);
});

test("only the owner writes the clipboard", async () => {
  const source = 'await navigator.clipboard.writeText("2026/014");';
  const [owner, caller] = await Promise.all([
    lintSingleRule(WRITE_RULE, source, { plugin: PLUGIN, sourcePath: OWNER }),
    lintSingleRule(WRITE_RULE, source, { plugin: PLUGIN, sourcePath: CALLER }),
  ]);
  expect(owner).toEqual([]);
  expect(caller).toEqual([1]);
});

test("only the owner imports the copy primitives and clipboard helpers", async () => {
  const source = `import { CopyFeedback, useCopiedFeedback } from "@stll/ui/copy-button";
import { CopyButton, useCopyConfirmation } from "@stll/ui/copy-button";
import { CopyFeedback as BarrelFeedback } from "@stll/ui";
import { copyToClipboard } from "@stll/clipboard";
import { COPIED_RESET_MS } from "@stll/ui/copy-button";
export const parts = [CopyFeedback, useCopiedFeedback, CopyButton, useCopyConfirmation, BarrelFeedback, copyToClipboard, COPIED_RESET_MS];`;
  const [owner, caller] = await Promise.all([
    lintSingleRule(PLUGIN, source, { sourcePath: OWNER }),
    lintSingleRule(PLUGIN, source, {
      sourcePath: "apps/web/src/features/chat/answer-edit/actions.tsx",
    }),
  ]);
  expect(owner).toEqual([]);
  expect(caller).toEqual([1, 1, 2, 2, 3, 4]);
});

test("the package barrel may re-export the copy primitives", async () => {
  const source = 'export * from "@stll/ui/copy-button";';
  const [barrel, other] = await Promise.all([
    lintSingleRule(PLUGIN, source, { sourcePath: "packages/ui/src/index.ts" }),
    lintSingleRule(PLUGIN, source, { sourcePath: "packages/ui/src/other.ts" }),
  ]);
  expect(barrel).toEqual([]);
  expect(other).toEqual([1]);
});
