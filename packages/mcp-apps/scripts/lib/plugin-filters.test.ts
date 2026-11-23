import { expect, test } from "bun:test";

import {
  READER_FONT_STYLESHEET,
  SHARED_GENERATED_MODULE,
} from "./plugin-filters";

test("the reader font filter matches its stylesheet with either separator", () => {
  expect(
    READER_FONT_STYLESHEET.test(
      "/store/@fontsource-variable/source-serif-4/index.css",
    ),
  ).toBe(true);
  expect(
    READER_FONT_STYLESHEET.test(
      String.raw`C:\store\@fontsource-variable\source-serif-4\index.css`,
    ),
  ).toBe(true);
  expect(
    READER_FONT_STYLESHEET.test(
      String.raw`C:\store\@fontsource-variable\source-serif-4\files\font.woff2`,
    ),
  ).toBe(false);
});

test("the shared generated filter matches with either separator", () => {
  expect(
    SHARED_GENERATED_MODULE.test("/repo/src/shared/generated/style.css"),
  ).toBe(true);
  expect(
    SHARED_GENERATED_MODULE.test(
      String.raw`D:\repo\src\shared\generated\style.css`,
    ),
  ).toBe(true);
  expect(SHARED_GENERATED_MODULE.test("/repo/src/shared/style.css")).toBe(
    false,
  );
});
