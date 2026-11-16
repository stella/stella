import { expect, test } from "bun:test";

import { EXTENSION_ICONS } from "../wxt.config";

test("the popup mark is the extension's own icon", async () => {
  const popup = await Bun.file(
    new URL("../src/entrypoints/popup/index.html", import.meta.url),
  ).text();
  const marks = [...popup.matchAll(/<img\b[^>]*\bclass="mark"[^>]*>/gu)];
  expect(marks).toHaveLength(1);
  const source = /\bsrc="([^"]+)"/u.exec(marks.at(0)?.[0] ?? "")?.at(1);
  // The largest manifest icon, so it stays sharp at the mark's size.
  expect(source).toBe(`/${EXTENSION_ICONS[128]}`);
});
