import { describe, expect, test } from "bun:test";

import { type PageCleanScan, placeCleanScan } from "./clean-scan-placement";

const scan = ({
  dpi,
  height,
  width,
}: {
  dpi: number;
  height: number;
  width: number;
}) =>
  ({
    image: {
      pixels: new Uint8Array(width * height),
      width,
      height,
      format: "grayscale",
    },
    pageSize: { widthPoints: 200, heightPoints: 300 },
    dpi,
  }) satisfies PageCleanScan;

describe("cleaned scan placement", () => {
  test.each([0, 90, 180, 270] as const)(
    "keeps the scanned physical size, centred on the source page box at %i degrees",
    (rotation) => {
      expect(
        placeCleanScan(scan({ dpi: 144, width: 120, height: 180 }), rotation),
      ).toEqual({
        box: {
          xPoints: 0,
          yPoints: 0,
          widthPoints: 200,
          heightPoints: 300,
          rotation,
        },
        image: { x: 70, y: 105, width: 60, height: 90 },
      });
    },
  );

  test("scales an image that deskewing grew past the page down to fit", () => {
    const { image } = placeCleanScan(
      scan({ dpi: 72, width: 400, height: 400 }),
      0,
    );

    expect(image).toEqual({ x: 0, y: 50, width: 200, height: 200 });
  });
});
