import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects menu items mounted as dialog render targets", async () => {
  expect(
    await lintSingleRule(
      "no-dialog-trigger-menu-item",
      "const view = <AlertDialogTrigger render={<MenuItem closeOnClick={false} />} />;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});

test("rejects direct menu item children of triggers", async () => {
  expect(
    await lintSingleRule(
      "no-dialog-trigger-menu-item",
      "const view = <SheetTrigger><DropdownMenuItem /></SheetTrigger>;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});

test("rejects compound trigger and menu item names", async () => {
  expect(
    await lintSingleRule(
      "no-dialog-trigger-menu-item",
      "const view = <UI.DialogTrigger render={<UI.ContextMenuItem />} />;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});

test("accepts a dialog lifted beside the menu", async () => {
  expect(
    await lintSingleRule(
      "no-dialog-trigger-menu-item",
      "const view = <><MenuItem onClick={() => setOpen(true)} /><Dialog open={open} /></>;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("accepts ordinary buttons as trigger targets", async () => {
  expect(
    await lintSingleRule(
      "no-dialog-trigger-menu-item",
      "const view = <PopoverTrigger render={<Button />} />;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});
