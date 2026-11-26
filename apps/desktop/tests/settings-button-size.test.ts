import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MAINVIEW = path.join(import.meta.dir, "../src/mainview");

/** The sizes a Settings button may take besides the default: an icon-only
 *  button of the same height, and a link inside a sentence. */
const ALLOWED_SIZES = new Set(["icon", "inline"]);

/** Windows of their own that mainview also renders, drawn compact. */
const OWN_WINDOWS = new Set(["DictationNoticeApp.tsx"]);

/** Every `size` given to a `<Button>` in `source`, as `file:line size`. */
const buttonSizes = (file: string, source: string): string[] =>
  [...source.matchAll(/\bsize="([^"]+)"/gu)].flatMap((match) => {
    const before = source.slice(0, match.index);
    const tag = [...before.matchAll(/<([A-Z][\w.]*)/gu)].at(-1)?.[1];
    if (tag !== "Button") {
      return [];
    }
    const line = before.split("\n").length;
    return [`${file}:${line} ${match[1] ?? ""}`];
  });

// A row's action sits beside the other rows' actions on one page: Sign
// out, Check again and Add folder share the default height, so a smaller
// one reads as a different kind of control.
test("Settings buttons share one size", () => {
  const files = readdirSync(MAINVIEW).filter(
    (name) => name.endsWith(".tsx") && !OWN_WINDOWS.has(name),
  );
  expect(files).toContain("App.tsx");
  const sized = files.flatMap((file) =>
    buttonSizes(file, readFileSync(path.join(MAINVIEW, file), "utf-8")),
  );
  expect(
    sized.filter((entry) => !ALLOWED_SIZES.has(entry.split(" ")[1] ?? "")),
  ).toEqual([]);
});
