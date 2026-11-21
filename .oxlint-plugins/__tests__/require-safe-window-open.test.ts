import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("require-safe-window-open", () => {
  test("reports direct browser calls even with isolation flags", async () => {
    expect(
      await lintSingleRule(
        "require-safe-window-open",
        'window.open(url, "_blank", "noopener,noreferrer");',
      ),
    ).toEqual([1]);
  });
  test("reports destructured and indirect browser aliases", async () => {
    expect(
      await lintSingleRule(
        "require-safe-window-open",
        "const { open: popup } = window;\npopup(url);\n(0, globalThis.window.open)(url);",
      ),
    ).toEqual([2, 3]);
  });
  test("accepts local bindings with browser-like names", async () => {
    expect(
      await lintSingleRule(
        "require-safe-window-open",
        "function launch(window, open) { window.open(url); open(url); }",
      ),
    ).toEqual([]);
  });
  test("accepts the sanctioned navigation helper", async () => {
    expect(
      await lintSingleRule(
        "require-safe-window-open",
        "openIsolatedWindow(url);",
      ),
    ).toEqual([]);
  });
});
