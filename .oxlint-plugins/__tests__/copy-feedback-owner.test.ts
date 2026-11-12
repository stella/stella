import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const PLUGIN = "copy-feedback-owner";
const LISTENER_RULE = "no-raw-copy-listener";
const SELECTION_OWNER = "apps/web/src/components/selection-toolbar-actions.tsx";

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
      { plugin: PLUGIN, sourcePath: "apps/web/src/components/bar.tsx" },
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
declare const CopyButton: (props: { onCopy: () => Promise<boolean> }) => null;
root.addEventListener("selectionchange", confirm);
root.removeEventListener("copy", confirm);
export const c = <CopyButton onCopy={write} />;
export const d = <Copy.Button onCopy={write} />;`,
      { plugin: PLUGIN, sourcePath: "apps/web/src/components/bar.tsx" },
    ),
  ).toEqual([]);
});

test("the copy owners may listen; any other file may not", async () => {
  const source = 'document.addEventListener("copy", () => {});';
  const [selectionOwner, transcriptOwner, caller] = await Promise.all([
    lintSingleRule(LISTENER_RULE, source, {
      plugin: PLUGIN,
      sourcePath: SELECTION_OWNER,
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
  expect(selectionOwner).toEqual([]);
  expect(transcriptOwner).toEqual([]);
  expect(caller).toEqual([1]);
});

test("only the selection owner builds a Copy from the feedback primitives", async () => {
  const source = `import { CopyFeedback, useCopiedFeedback } from "@stll/ui/copy-button";
import { CopyButton } from "@stll/ui/copy-button";
import { CopyFeedback as BarrelFeedback } from "@stll/ui";
export const parts = [CopyFeedback, useCopiedFeedback, CopyButton, BarrelFeedback];`;
  const [owner, caller] = await Promise.all([
    lintSingleRule(PLUGIN, source, { sourcePath: SELECTION_OWNER }),
    lintSingleRule(PLUGIN, source, {
      sourcePath: "apps/web/src/features/chat/answer-edit/actions.tsx",
    }),
  ]);
  expect(owner).toEqual([]);
  expect(caller).toEqual([1, 1, 3]);
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
