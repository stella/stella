import { describe, expect, test } from "bun:test";

import type { ImageRun } from "../layout-engine/types";
import {
  isFloatingImageRun,
  isTextWrappingFloatingImageRun,
} from "./renderUtils";

// Issue #418 (eigenpal): wrapNone images (behind/inFront) are anchored floats
// but must NOT shrink line widths — text paints over or under them. Folio's
// previous classifier excluded behind/inFront from "floating" entirely, so
// they fell back to inline rendering and pushed paragraph flow.

const baseImage = (
  wrapType: string | undefined,
  extras: Partial<ImageRun> = {},
): ImageRun => {
  const base: ImageRun = {
    kind: "image",
    src: "img.png",
    width: 100,
    height: 100,
  };
  if (wrapType !== undefined) {
    base.wrapType = wrapType;
  }
  return { ...base, ...extras };
};

describe("isFloatingImageRun (issue #418)", () => {
  test("recognizes behind as floating", () => {
    expect(isFloatingImageRun(baseImage("behind"))).toBe(true);
  });

  test("recognizes inFront as floating", () => {
    expect(isFloatingImageRun(baseImage("inFront"))).toBe(true);
  });

  test("recognizes square/tight/through as floating", () => {
    expect(isFloatingImageRun(baseImage("square"))).toBe(true);
    expect(isFloatingImageRun(baseImage("tight"))).toBe(true);
    expect(isFloatingImageRun(baseImage("through"))).toBe(true);
  });

  test("inline image is not floating", () => {
    expect(isFloatingImageRun(baseImage("inline"))).toBe(false);
  });

  test("topAndBottom is not floating (it's a block image)", () => {
    expect(isFloatingImageRun(baseImage("topAndBottom"))).toBe(false);
  });

  test("explicit displayMode='float' overrides missing wrapType", () => {
    expect(
      isFloatingImageRun(
        baseImage(undefined, { displayMode: "float", cssFloat: "left" }),
      ),
    ).toBe(true);
  });
});

describe("isTextWrappingFloatingImageRun (issue #418)", () => {
  test("behind images do not wrap text", () => {
    expect(isTextWrappingFloatingImageRun(baseImage("behind"))).toBe(false);
  });

  test("inFront images do not wrap text", () => {
    expect(isTextWrappingFloatingImageRun(baseImage("inFront"))).toBe(false);
  });

  test("topAndBottom does not wrap text (block, not side-wrapped)", () => {
    expect(isTextWrappingFloatingImageRun(baseImage("topAndBottom"))).toBe(
      false,
    );
  });

  test("square/tight/through wrap text", () => {
    expect(isTextWrappingFloatingImageRun(baseImage("square"))).toBe(true);
    expect(isTextWrappingFloatingImageRun(baseImage("tight"))).toBe(true);
    expect(isTextWrappingFloatingImageRun(baseImage("through"))).toBe(true);
  });

  test("explicit cssFloat without wrap type wraps text", () => {
    expect(
      isTextWrappingFloatingImageRun(
        baseImage(undefined, { displayMode: "float", cssFloat: "left" }),
      ),
    ).toBe(true);
  });

  test("inline images don't wrap text (they aren't floating in the first place)", () => {
    expect(isTextWrappingFloatingImageRun(baseImage("inline"))).toBe(false);
  });
});
