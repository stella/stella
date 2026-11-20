import { describe, expect, test } from "bun:test";

import {
  type GeoPoint,
  getBaseMap,
  LOCATION_MAP_DISPLAY_SIZE,
  MAP_COLORS,
  type Raster,
  rasterizeLocationMap,
  renderLocationMap,
} from "./location-map";

const PRAGUE = { latitude: 50.1, longitude: 14.4 } as const;
const MASERU = { latitude: -29.3, longitude: 27.5 } as const;
const MID_ATLANTIC = { latitude: 30, longitude: -40 } as const;

const rasterize = async (point: GeoPoint) =>
  rasterizeLocationMap(point, await getBaseMap());

/** The pixel at an offset, in image pixels, from the map's centre. */
const pixelFromCenter = (
  { width, height, rgb }: Raster,
  dx: number,
  dy: number,
) => {
  const offset = ((height / 2 + dy) * width + width / 2 + dx) * 3;
  return [rgb[offset], rgb[offset + 1], rgb[offset + 2]];
};

const countPixels = ({ rgb }: Raster, color: readonly number[]) => {
  let count = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    if (
      rgb[i] === color[0] &&
      rgb[i + 1] === color[1] &&
      rgb[i + 2] === color[2]
    ) {
      count++;
    }
  }
  return count;
};

describe("location map", () => {
  test("encodes a PNG at twice the display size, small enough to attach", async () => {
    const png = await renderLocationMap(PRAGUE);

    const metadata = await new Bun.Image(png).metadata();
    expect(metadata).toEqual({
      format: "png",
      width: LOCATION_MAP_DISPLAY_SIZE.width * 2,
      height: LOCATION_MAP_DISPLAY_SIZE.height * 2,
    });
    expect(png.length).toBeLessThan(24_000);
  });

  test("the same point renders the same bytes", async () => {
    expect(await renderLocationMap(PRAGUE)).toEqual(
      await renderLocationMap(PRAGUE),
    );
  });

  test("the dot marks the centre and the country around it is set apart", async () => {
    const raster = await rasterize(PRAGUE);

    expect(pixelFromCenter(raster, 0, 0)).toEqual([...MAP_COLORS.dot]);
    // Moravia, east of the dot, is in the same country.
    expect(pixelFromCenter(raster, 100, 20)).toEqual([...MAP_COLORS.home]);
    // Poland, north-east, is a neighbour.
    expect(pixelFromCenter(raster, 150, -150)).toEqual([...MAP_COLORS.land]);
    // The North Sea, far north-west.
    expect(pixelFromCenter(raster, -350, -180)).toEqual([...MAP_COLORS.water]);
  });

  test("an enclave's surrounding country keeps its hole", async () => {
    const raster = await rasterize(MASERU);

    expect(pixelFromCenter(raster, 0, 0)).toEqual([...MAP_COLORS.dot]);
    // South Africa surrounds Lesotho but is not where the dot is.
    expect(pixelFromCenter(raster, -200, 0)).toEqual([...MAP_COLORS.land]);
    expect(countPixels(raster, MAP_COLORS.home)).toBeGreaterThan(1000);
  });

  test("a point at sea highlights no country", async () => {
    const raster = await rasterize(MID_ATLANTIC);

    expect(countPixels(raster, MAP_COLORS.home)).toBe(0);
    expect(pixelFromCenter(raster, -400, -200)).toEqual([...MAP_COLORS.water]);
  });

  test("islands cut by the antimeridian stay whole, with no edge across the map", async () => {
    // Fiji's islands straddle 180°; a ring left split there would join its
    // two halves with an edge spanning the whole view.
    const { width, height, rgb } = await rasterize({
      latitude: -16.6,
      longitude: 179.9,
    });
    const flatFills = [MAP_COLORS.water, MAP_COLORS.land, MAP_COLORS.home];
    let mostEdgePixelsInARow = 0;
    for (let y = 0; y < height; y++) {
      let edgePixels = 0;
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 3;
        const isFlat = flatFills.some(
          (color) =>
            rgb[offset] === color[0] &&
            rgb[offset + 1] === color[1] &&
            rgb[offset + 2] === color[2],
        );
        if (!isFlat) {
          edgePixels++;
        }
      }
      mostEdgePixelsInARow = Math.max(mostEdgePixelsInARow, edgePixels);
    }
    expect(mostEdgePixelsInARow).toBeLessThan(width / 2);
  });

  test.each([
    { latitude: -17.8, longitude: 178.4 },
    { latitude: 65.5, longitude: -172 },
    { latitude: -41.3, longitude: 174.8 },
  ])(
    "a view across the antimeridian is the same a whole turn away: %p",
    async ({ latitude, longitude }) => {
      const raster = await rasterize({ latitude, longitude });
      const turned = await rasterize({
        latitude,
        longitude: longitude > 0 ? longitude - 360 : longitude + 360,
      });

      expect(
        countPixels(raster, MAP_COLORS.land) +
          countPixels(raster, MAP_COLORS.home),
      ).toBeGreaterThan(1000);
      expect(turned.rgb).toEqual(raster.rgb);
    },
  );
});
