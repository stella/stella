import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const DESKTOP_ROOT = path.join(import.meta.dir, "..");
const SECTION_SIGN = /^(?:§|&sect;|&#167;|&#x0*a7;)$/iu;
const ELEMENT_TEXT = />([^<]*)</gu;

// Every bundled page lives under src; build output and dependencies do not.
const desktopPages = () =>
  [...new Glob("src/**/*.html").scanSync({ cwd: DESKTOP_ROOT })].toSorted();

const loneSectionSigns = (html: string) =>
  [...html.matchAll(ELEMENT_TEXT)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((text) => SECTION_SIGN.test(text));

describe("desktop HTML pages", () => {
  test("are scanned", () => {
    expect(desktopPages()).toContain("src/mainview/pdf-sign-dialog.html");
  });

  test.each(desktopPages())(
    "%s draws the stella mark, not a section sign",
    (page) => {
      const found = loneSectionSigns(
        readFileSync(path.join(DESKTOP_ROOT, page), "utf-8"),
      );
      expect(
        found,
        `${page} uses a lone '§' as a logo. Use the stella mark SVG from packages/ui/src/components/stella-mark.tsx (fill="currentColor", aria-hidden="true").`,
      ).toEqual([]);
    },
  );

  test("the detector catches every spelling and leaves prose alone", () => {
    for (const mark of ["§", " &sect; ", "&#167;", "&#xA7;"]) {
      expect(loneSectionSigns(`<div class="mark">${mark}</div>`)).toHaveLength(
        1,
      );
    }
    expect(loneSectionSigns("<p>See § 12 of the act.</p>")).toEqual([]);
  });
});
