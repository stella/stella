// eigenpal/docx-editor#787 (issue #777) — an anchored image alone on a line is
// positioned by its own `wp:positionH` alignment, defaulting to LEFT like Word,
// not by the paragraph's `jc`. An inline image (no anchor) follows the
// paragraph alignment. Word's `inside`/`outside` collapse to left/right.

import { describe, expect, test } from "bun:test";

import type { ImageRun, ImageRunPosition } from "../layout-engine/types";
import { resolveImageLineAlign } from "./renderUtils";

function img(horizontal?: ImageRunPosition["horizontal"]): ImageRun {
  return {
    kind: "image",
    src: "logo.png",
    width: 100,
    height: 50,
    ...(horizontal ? { position: { horizontal } } : {}),
  };
}

describe("resolveImageLineAlign", () => {
  test("anchored image keeps its explicit alignment, ignoring the paragraph jc", () => {
    expect(resolveImageLineAlign(img({ align: "left" }), "center")).toBe(
      "left",
    );
    expect(resolveImageLineAlign(img({ align: "right" }), "center")).toBe(
      "right",
    );
    expect(resolveImageLineAlign(img({ align: "center" }), "left")).toBe(
      "center",
    );
  });

  test("anchored image maps inside/outside to left/right", () => {
    expect(resolveImageLineAlign(img({ align: "inside" }), "center")).toBe(
      "left",
    );
    expect(resolveImageLineAlign(img({ align: "outside" }), "left")).toBe(
      "right",
    );
  });

  test("anchored image with no explicit alignment defaults to left, NOT the paragraph jc", () => {
    expect(resolveImageLineAlign(img({}), "center")).toBe("left");
    expect(resolveImageLineAlign(img({}), "right")).toBe("left");
  });

  test("inline image (no anchor) follows the paragraph alignment", () => {
    expect(resolveImageLineAlign(img(undefined), "center")).toBe("center");
    expect(resolveImageLineAlign(img(undefined), "right")).toBe("right");
    expect(resolveImageLineAlign(img(undefined), undefined)).toBeUndefined();
  });
});
