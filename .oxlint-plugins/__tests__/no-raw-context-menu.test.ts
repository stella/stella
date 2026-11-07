import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-raw-context-menu";

test("rejects a JSX handler, a props object and a DOM listener", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `declare const open: () => void;
declare const host: HTMLElement;
export const a = <div onContextMenu={open} />;
export const b = <div onContextMenuCapture={open} />;
export const props = { onContextMenu: open };
export const quoted = { "onContextMenu": open };
host.addEventListener("contextmenu", open);
document.addEventListener(\`contextmenu\`, open, { capture: true });
window["addEventListener"]("contextmenu", open);`,
      { sourcePath: "apps/web/src/components/row.tsx" },
    ),
  ).toEqual([3, 4, 5, 6, 7, 8, 9]);
});

test("accepts types, destructuring, other events and a custom trigger prop", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `type RowProps = { onContextMenu?: (event: MouseEvent) => void };
declare const host: HTMLElement;
declare const open: () => void;
declare const Picker: (props: { trigger: "contextmenu" | "click" }) => null;
export const Row = ({ onContextMenu }: RowProps) => onContextMenu;
host.addEventListener("click", open);
host.removeEventListener("contextmenu", open);
export const c = <Picker trigger="contextmenu" />;`,
      { sourcePath: "apps/web/src/components/row.tsx" },
    ),
  ).toEqual([]);
});

test("the owners may listen; any other file may not", async () => {
  const source = 'document.addEventListener("contextmenu", () => {});';
  const [desktopOwner, uiOwner, caller] = await Promise.all([
    lintSingleRule(RULE, source, {
      sourcePath: "apps/desktop/src/shared/native-context-menu.ts",
    }),
    lintSingleRule(RULE, source, {
      sourcePath: "packages/ui/src/components/entity-actions.tsx",
    }),
    lintSingleRule(RULE, source, {
      sourcePath: "apps/desktop/src/shared/not-native-context-menu.ts",
    }),
  ]);
  expect(desktopOwner).toEqual([]);
  expect(uiOwner).toEqual([]);
  expect(caller).toEqual([1]);
});
