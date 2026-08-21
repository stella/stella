import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { resizeRgbRegion, rgbaToRgb } from "./rgb-image";

describe("OCR RGB image primitives", () => {
  test("drops alpha without changing channel order", () => {
    expect(
      rgbaToRgb({
        data: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 0]),
        width: 2,
        height: 1,
      }),
    ).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  test("bilinearly averages a two-by-two image", () => {
    expect(
      resizeRgbRegion({
        data: new Uint8Array([
          0, 0, 0, 100, 100, 100, 200, 200, 200, 255, 255, 255,
        ]),
        width: 2,
        height: 2,
        targetWidth: 1,
        targetHeight: 1,
      }),
    ).toEqual(new Uint8Array([139, 139, 139]));
  });

  test("crops before resizing", () => {
    const data = new Uint8Array([1, 2, 3, 10, 20, 30, 4, 5, 6, 40, 50, 60]);
    expect(
      resizeRgbRegion({
        data,
        width: 2,
        height: 2,
        left: 1,
        top: 0,
        regionWidth: 1,
        regionHeight: 2,
        targetWidth: 1,
        targetHeight: 2,
      }),
    ).toEqual(new Uint8Array([10, 20, 30, 40, 50, 60]));
  });

  test("preserves every valid image under an identity resize", () => {
    const image = fc
      .tuple(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 8 }))
      .chain(([width, height]) =>
        fc
          .uint8Array({
            minLength: width * height * 3,
            maxLength: width * height * 3,
          })
          .map((data) => ({ data, width, height })),
      );
    fc.assert(
      fc.property(image, ({ data, height, width }) => {
        expect(
          resizeRgbRegion({
            data,
            height,
            width,
            targetHeight: height,
            targetWidth: width,
          }),
        ).toEqual(data);
      }),
      propertyConfig({ numRuns: 100 }),
    );
  });

  test("rejects inconsistent dimensions and out-of-bounds regions", () => {
    expect(() =>
      rgbaToRgb({ data: new Uint8Array(3), width: 1, height: 1 }),
    ).toThrow(/invalid RGBA image shape/u);
    expect(() =>
      resizeRgbRegion({
        data: new Uint8Array(3),
        width: 1,
        height: 1,
        left: 1,
        regionWidth: 1,
        targetWidth: 1,
        targetHeight: 1,
      }),
    ).toThrow(/invalid RGB resize/u);
  });
});
