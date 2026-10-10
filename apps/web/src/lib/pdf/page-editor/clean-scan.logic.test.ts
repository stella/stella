import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  applyAll,
  applyOne,
  createCleanScanReview,
  reviewPage,
  targetPageBox,
  undoCleanScanReview,
} from "./clean-scan.logic";
import type {
  RasterizedScanPage,
  ScanEngine,
  ScanOptions,
  ScanResult,
} from "./scan-engine";

class FakeScanEngine implements ScanEngine {
  receivedOptions: ScanOptions[] = [];
  private readonly result: ScanResult;

  constructor(result: ScanResult) {
    this.result = result;
  }

  clean = async (_page: RasterizedScanPage, options: ScanOptions) => {
    this.receivedOptions.push(options);
    return Result.ok(this.result);
  };
}

const page = (dpi: number, rotation: RasterizedScanPage["rotation"]) => ({
  pixels: new Uint8ClampedArray(400 * 600 * 4),
  width: 400,
  height: 600,
  pageSize: { widthPoints: 612, heightPoints: 792 },
  dpi,
  rotation,
});

const cleanedResult = (format: ScanOptions["output"]): ScanResult => ({
  type: "cleaned",
  image: {
    pixels: new Uint8Array(200 * 300),
    width: 200,
    height: 300,
    format,
  },
  appliedQuad: null,
  skewDegrees: 0,
  contentBox: { x: 0, y: 0, width: 200, height: 300 },
});

const options = (output: ScanOptions["output"]): ScanOptions => ({
  output,
  contentCrop: "on",
  deskew: "on",
});

describe("clean scan page review", () => {
  test("keeps unrecognized pages visible and unapplied", async () => {
    const engine = new FakeScanEngine({
      type: "unrecognized",
      reason: "No page boundary found",
    });
    const result = await reviewPage({
      engine,
      pageId: "page-1",
      page: page(144, 0),
      options: options("grayscale"),
    });

    expect(result).toEqual(
      Result.ok({
        type: "unrecognized",
        pageId: "page-1",
        reason: "No page boundary found",
      }),
    );
    if (result.isOk()) {
      expect(applyAll({ pages: [result.value], past: [] }).pages).toEqual([
        result.value,
      ]);
    }
  });

  test("restores every previous state after apply all and undo", () => {
    const scan = cleanedResult("grayscale");
    if (scan.type !== "cleaned") {
      throw new Error("Expected cleaned scan fixture");
    }
    const before = {
      ...createCleanScanReview([]),
      pages: [
        { type: "preview", pageId: "preview", scan },
        { type: "rejected", pageId: "rejected", scan },
        { type: "unrecognized", pageId: "unknown", reason: "No page" },
      ],
    } satisfies ReturnType<typeof createCleanScanReview>;

    const restored = undoCleanScanReview(applyAll(before));

    expect(restored).toEqual(before);
  });

  test("applies only the selected preview", () => {
    const scan = cleanedResult("grayscale");
    if (scan.type !== "cleaned") {
      throw new Error("Expected cleaned scan fixture");
    }
    const before = {
      ...createCleanScanReview([]),
      pages: [
        { type: "preview", pageId: "selected", scan },
        { type: "preview", pageId: "other", scan },
      ],
    } satisfies ReturnType<typeof createCleanScanReview>;

    expect(applyOne(before, "selected").pages).toEqual([
      { type: "applied", pageId: "selected", scan },
      { type: "preview", pageId: "other", scan },
    ]);
  });

  test.each([
    { dpi: 72, rotation: 0 },
    { dpi: 144, rotation: 90 },
    { dpi: 300, rotation: 180 },
    { dpi: 600, rotation: 270 },
  ] satisfies { dpi: number; rotation: RasterizedScanPage["rotation"] }[])(
    "preserves the original physical size at $dpi DPI and $rotation degrees",
    ({ dpi, rotation }) => {
      const raster = page(dpi, rotation);

      expect(targetPageBox(raster.pageSize, raster.rotation)).toEqual({
        xPoints: 0,
        yPoints: 0,
        widthPoints: 612,
        heightPoints: 792,
        rotation,
      });
    },
  );

  test.each(["grayscale", "binary"] satisfies ScanOptions["output"][])(
    "passes the %s output option to the engine",
    async (output) => {
      const engine = new FakeScanEngine(cleanedResult(output));
      const scanOptions = options(output);

      await reviewPage({
        engine,
        pageId: "page-1",
        page: page(300, 0),
        options: scanOptions,
      });

      expect(engine.receivedOptions).toEqual([scanOptions]);
    },
  );
});
