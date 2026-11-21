import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("no-portal-under-interactive-ancestor", () => {
  test("reports popups under interactive ancestors", async () => {
    expect(
      await lintSingleRule(
        "no-portal-under-interactive-ancestor",
        "const page = <Button><span><DialogContent /></span></Button>;",
        { sourcePath: "source.tsx", plugin: "require-contained-handler" },
      ),
    ).toEqual([1]);
  });
  test("reports popups under uncontained event containers", async () => {
    expect(
      await lintSingleRule(
        "no-portal-under-interactive-ancestor",
        "const page = <div onPointerDown={handle}><ComboboxPopup /></div>;",
        { sourcePath: "source.tsx", plugin: "require-contained-handler" },
      ),
    ).toEqual([1]);
  });
  test("accepts lifted popups and ordinary containers", async () => {
    expect(
      await lintSingleRule(
        "no-portal-under-interactive-ancestor",
        "const page = <><Button /><DialogContent /><div><MenuPopup /></div></>;",
        { sourcePath: "source.tsx", plugin: "require-contained-handler" },
      ),
    ).toEqual([]);
  });
  test("accepts contained ancestor handlers", async () => {
    expect(
      await lintSingleRule(
        "no-portal-under-interactive-ancestor",
        "const page = <div onClick={containedEventHandler(handle)}><PopoverPopup /></div>;",
        { sourcePath: "source.tsx", plugin: "require-contained-handler" },
      ),
    ).toEqual([]);
  });
});
