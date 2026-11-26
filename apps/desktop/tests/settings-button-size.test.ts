import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { guardEnforcesLine } from "../../../scripts/guard-rollouts.ts";

const GUARD = "settings-button-size";
const MAINVIEW_DIRECTORY = "apps/desktop/src/mainview";
const ROOT = path.resolve(import.meta.dir, "../../..");

/** The sizes a Settings button may take besides the default: an icon-only
 *  button of the same height, and a link inside a sentence. */
const ALLOWED_SIZES = new Set(["icon", "inline"]);

/** Windows of their own that mainview also renders, drawn compact. */
const OWN_WINDOWS = new Set(["DictationNoticeApp.tsx"]);

type SizedButton = { file: string; line: number; size: string };

/** Every `size` given to a `<Button>` in `source`. */
const sizedButtons = (file: string, source: string): SizedButton[] =>
  [...source.matchAll(/\bsize="([^"]+)"/gu)].flatMap((match) => {
    const before = source.slice(0, match.index);
    const tag = [...before.matchAll(/<([A-Z][\w.]*)/gu)].at(-1)?.[1];
    if (tag !== "Button") {
      return [];
    }
    return [{ file, line: before.split("\n").length, size: match[1] ?? "" }];
  });

// A row's action sits beside the other rows' actions on one page: Sign
// out, Check again and Add folder share the default height, so a smaller
// one reads as a different kind of control.
test("Settings buttons share one size", () => {
  const files = readdirSync(path.join(ROOT, MAINVIEW_DIRECTORY)).filter(
    (name) => name.endsWith(".tsx") && !OWN_WINDOWS.has(name),
  );
  expect(files).toContain("App.tsx");
  const violations = files
    .flatMap((name) => {
      const file = `${MAINVIEW_DIRECTORY}/${name}`;
      return sizedButtons(file, readFileSync(path.join(ROOT, file), "utf-8"));
    })
    .filter(({ size }) => !ALLOWED_SIZES.has(size))
    .filter(({ file, line }) => guardEnforcesLine({ guard: GUARD, file, line }))
    .map(({ file, line, size }) => `${file}:${line}: Button size="${size}"`);
  expect(violations).toEqual([]);
});
