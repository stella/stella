import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import { PDF_SIGNING_STAMP_SIZE_LIMITS_PT } from "@stll/api-contract/limits";

import { placeStamp } from "@/api/lib/files/pdf-signing/stamp";

/**
 * The browser keeps a drawn stamp inside the contract's limits. Each limit is
 * read back from `placeStamp` itself: a box at the limit is placed and one a
 * point past it is refused, so the two sides cannot drift apart.
 */
const PAGE = { height: 800, width: 600 } as const;

const placeSized = async (widthPt: number, heightPt: number) => {
  const created = PDF.create();
  created.addPage(PAGE);
  const pdf = await PDF.load(await created.save());
  const placed = placeStamp({
    box: {
      height: heightPt / PAGE.height,
      width: widthPt / PAGE.width,
      x: 0,
      y: 0,
    },
    pageIndex: 0,
    pdf,
  });
  return placed.status === "placed" ? "placed" : placed.reason;
};

describe("the stamp size limits the browser draws within", () => {
  const { maxHeight, maxWidth, minHeight, minWidth } =
    PDF_SIGNING_STAMP_SIZE_LIMITS_PT;

  test("are the sizes the API places a stamp at", async () => {
    expect(await placeSized(minWidth, minHeight)).toBe("placed");
    expect(await placeSized(maxWidth, maxHeight)).toBe("placed");
  });

  test("are where the API starts refusing a stamp", async () => {
    expect(await placeSized(minWidth - 1, minHeight)).toBe("too_small");
    expect(await placeSized(minWidth, minHeight - 1)).toBe("too_small");
    expect(await placeSized(maxWidth + 1, maxHeight)).toBe("too_large");
    expect(await placeSized(maxWidth, maxHeight + 1)).toBe("too_large");
  });
});
