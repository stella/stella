import { panic } from "better-result";
import { crc32, deflateSync } from "node:zlib";

import type { CountryCode } from "@stll/country-codes";

import { brand } from "../emails/_shared";
import { COUNTRY_FEATURES, type FeatureSelector } from "./country-features";

/**
 * A small regional map with a dot on one point, rendered to PNG bytes for an
 * email to carry as an inline (`cid:`) image. Rendering stays on the server
 * and the mail client fetches nothing: no tile server, no third-party image
 * host, nothing that would learn the location or when the email was opened.
 *
 * The base map is Natural Earth's 1:50m Admin 0 countries (public domain),
 * shipped as TopoJSON by the `world-atlas` package (ISC).
 */

export type GeoPoint = { latitude: number; longitude: number };

/** The point to mark and the country the edge placed it in. */
export type MapPlace = { point: GeoPoint; countryCode: CountryCode };

/**
 * What the map did with the country. `unresolved` means the country table
 * names a feature the base map lacks: a defect for the caller to report, while
 * the map still renders, unshaded.
 */
export type CountryHighlight =
  | { type: "shaded" }
  | { type: "notDrawnAtThisScale" }
  | { type: "unresolved"; countryCode: CountryCode };

export type LocationMap = { png: Uint8Array; highlight: CountryHighlight };

/** CSS pixels the email lays the map out at; the image carries twice as many. */
export const LOCATION_MAP_DISPLAY_SIZE = { width: 472, height: 236 } as const;

export const LOCATION_MAP_CONTENT_TYPE = "image/png";

/**
 * A few flat fills plus their anti-aliased edges fit a small palette; an
 * indexed PNG is about half the size of the truecolour one.
 */
const PALETTE_COLORS = 32;

export const renderLocationMap = async (
  place: MapPlace,
): Promise<LocationMap> => {
  const { raster, highlight } = rasterizeLocationMap(place, await getBaseMap());
  const png = await new Bun.Image(encodePng(raster))
    .png({ palette: true, colors: PALETTE_COLORS, compressionLevel: 9 })
    .bytes();
  return { png, highlight };
};

const PIXEL_RATIO = 2;
const WIDTH = LOCATION_MAP_DISPLAY_SIZE.width * PIXEL_RATIO;
const HEIGHT = LOCATION_MAP_DISPLAY_SIZE.height * PIXEL_RATIO;
/** Subsamples per pixel side: edges blend over SUPERSAMPLE² coverage levels. */
const SUPERSAMPLE = 3;
/**
 * Longitude the view spans at the equator, widened by 1/cos(latitude) so the
 * ground distance across the map stays about the same everywhere (~2,000 km):
 * enough to show the country and its neighbours, too coarse to suggest more
 * precision than an IP-derived location has.
 */
const EQUATORIAL_SPAN_DEGREES = 18;
const MAX_SPAN_DEGREES = 120;
/** Mercator diverges at the poles; the view centre stays inside this band. */
const MAX_CENTER_LATITUDE = 80;
const MAX_LATITUDE = 85;
/** Half-width, in subsamples, of a border line either side of the boundary. */
const BORDER_HALF_WIDTH = 2;

type Rgb = readonly [number, number, number];

export const MAP_COLORS = {
  water: hexToRgb(brand.mapWater),
  land: hexToRgb(brand.mapLand),
  home: hexToRgb(brand.mapHome),
  border: hexToRgb(brand.mapBorder),
  dot: hexToRgb(brand.blue),
  ring: hexToRgb(brand.backgroundCard),
} as const satisfies Record<string, Rgb>;

const DOT = {
  haloRadius: 32,
  haloAlpha: 0.16,
  ringRadius: 13,
  dotRadius: 9,
} as const;

/** One polygon: rings of interleaved longitude/latitude, outer ring first. */
type Polygon = {
  rings: Float64Array[];
  west: number;
  east: number;
  south: number;
  north: number;
};

/** One Natural Earth feature; `id` is its ISO 3166-1 numeric code, if any. */
type BaseMapCountry = { id: string | null; name: string; polygons: Polygon[] };

type BaseMap = { countries: BaseMapCountry[] };

export type Raster = { width: number; height: number; rgb: Uint8Array };

type RasterizedLocationMap = { raster: Raster; highlight: CountryHighlight };

/**
 * The pixels of the map centred on the place's point, with its country
 * shaded. Exported so tests can read pixel colours without decoding the PNG.
 */
export const rasterizeLocationMap = (
  { point, countryCode }: MapPlace,
  baseMap: BaseMap,
): RasterizedLocationMap => {
  const view = createView(point);
  const subWidth = WIDTH * SUPERSAMPLE;
  const subHeight = HEIGHT * SUPERSAMPLE;
  // 0 is water; feature i is drawn as i + 1.
  const ids = new Uint16Array(subWidth * subHeight);
  const home = homeFeatures(countryCode, baseMap);
  const homeIds = new Set(
    home.type === "shaded" ? home.indexes.map((index) => index + 1) : [],
  );

  for (const [index, { polygons }] of baseMap.countries.entries()) {
    for (const polygon of polygons) {
      for (const offset of view.longitudeOffsets(polygon)) {
        fillPolygon({
          ids,
          id: index + 1,
          rings: polygon.rings.map((ring) => view.project(ring, offset)),
        });
      }
    }
  }

  const border = borderMask(ids, subWidth, subHeight);
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        const row = (y * SUPERSAMPLE + sy) * subWidth + x * SUPERSAMPLE;
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const index = row + sx;
          const color = subsampleColor({
            id: ids[index] ?? 0,
            homeIds,
            onBorder: border[index] === 1,
          });
          r += color[0];
          g += color[1];
          b += color[2];
        }
      }
      const offset = (y * WIDTH + x) * 3;
      rgb[offset] = Math.round(r / samples);
      rgb[offset + 1] = Math.round(g / samples);
      rgb[offset + 2] = Math.round(b / samples);
    }
  }

  drawDot(rgb);
  return {
    raster: { width: WIDTH, height: HEIGHT, rgb },
    highlight: highlightOf(home, countryCode),
  };
};

type HomeFeatures =
  | { type: "shaded"; indexes: number[] }
  | { type: "notDrawnAtThisScale" }
  | { type: "unresolved" };

const highlightOf = (
  home: HomeFeatures,
  countryCode: CountryCode,
): CountryHighlight => {
  switch (home.type) {
    case "shaded":
      return { type: "shaded" };
    case "notDrawnAtThisScale":
      return { type: "notDrawnAtThisScale" };
    case "unresolved":
      return { type: "unresolved", countryCode };
    default:
      home satisfies never;
      return panic("Unknown home feature state");
  }
};

/** The base map features that draw the country, by its table entry. */
const homeFeatures = (
  countryCode: CountryCode,
  { countries }: BaseMap,
): HomeFeatures => {
  const entry = COUNTRY_FEATURES[countryCode];
  if (entry.type === "notDrawn") {
    return { type: "notDrawnAtThisScale" };
  }
  const indexes: number[] = [];
  for (const selector of entry.features) {
    const matches = countries.flatMap((country, index) =>
      selectsFeature(selector, country) ? [index] : [],
    );
    if (matches.length === 0) {
      return { type: "unresolved" };
    }
    indexes.push(...matches);
  }
  return { type: "shaded", indexes };
};

/** Whether a table selector names this base map feature. */
export const selectsFeature = (
  selector: FeatureSelector,
  { id, name }: Pick<BaseMapCountry, "id" | "name">,
): boolean => {
  switch (selector.by) {
    case "isoNumeric":
      return id === selector.id;
    case "name":
      return id === null && name === selector.name;
    default:
      selector satisfies never;
      return panic("Unknown feature selector");
  }
};

type SubsampleColorOptions = {
  id: number;
  homeIds: ReadonlySet<number>;
  onBorder: boolean;
};

const subsampleColor = ({ id, homeIds, onBorder }: SubsampleColorOptions) => {
  if (onBorder) {
    return MAP_COLORS.border;
  }
  if (id === 0) {
    return MAP_COLORS.water;
  }
  return homeIds.has(id) ? MAP_COLORS.home : MAP_COLORS.land;
};

type View = {
  project: (ring: Float64Array, longitudeOffset: number) => Float64Array;
  /** The whole-turn shifts that bring a polygon into view (antimeridian). */
  longitudeOffsets: (polygon: Polygon) => number[];
};

const createView = ({ latitude, longitude }: GeoPoint): View => {
  const centerLatitude = clamp(
    latitude,
    -MAX_CENTER_LATITUDE,
    MAX_CENTER_LATITUDE,
  );
  const span = Math.min(
    EQUATORIAL_SPAN_DEGREES / Math.cos(toRadians(centerLatitude)),
    MAX_SPAN_DEGREES,
  );
  const scale = WIDTH / toRadians(span);
  const centerY = mercatorY(centerLatitude);
  const halfHeight = HEIGHT / 2 / scale;
  const south = inverseMercatorY(centerY - halfHeight);
  const north = inverseMercatorY(centerY + halfHeight);
  const west = longitude - span / 2;
  const east = longitude + span / 2;

  return {
    project: (ring, longitudeOffset) => {
      const projected = new Float64Array(ring.length);
      for (let i = 0; i < ring.length; i += 2) {
        projected[i] =
          WIDTH / 2 +
          toRadians((ring[i] ?? 0) + longitudeOffset - longitude) * scale;
        projected[i + 1] =
          HEIGHT / 2 - (mercatorY(ring[i + 1] ?? 0) - centerY) * scale;
      }
      return projected;
    },
    longitudeOffsets: (polygon) =>
      polygon.north < south || polygon.south > north
        ? []
        : [-360, 0, 360].filter(
            (offset) =>
              polygon.west + offset <= east && polygon.east + offset >= west,
          ),
  };
};

type FillPolygonOptions = {
  ids: Uint16Array;
  id: number;
  /** Projected rings, in pixels; filled even-odd so holes stay open. */
  rings: Float64Array[];
};

/** Scanline fill at subsample resolution. */
const fillPolygon = ({ ids, id, rings }: FillPolygonOptions): void => {
  const subWidth = WIDTH * SUPERSAMPLE;
  const subHeight = HEIGHT * SUPERSAMPLE;
  const edges: { top: number; bottom: number; x: number; slope: number }[] = [];
  for (const ring of rings) {
    const count = ring.length / 2;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const x1 = (ring[i * 2] ?? 0) * SUPERSAMPLE;
      const y1 = (ring[i * 2 + 1] ?? 0) * SUPERSAMPLE;
      const x2 = (ring[j * 2] ?? 0) * SUPERSAMPLE;
      const y2 = (ring[j * 2 + 1] ?? 0) * SUPERSAMPLE;
      if (y1 === y2) {
        continue;
      }
      const [xTop, yTop, yBottom] = y1 < y2 ? [x1, y1, y2] : [x2, y2, y1];
      // A subsample row samples at its centre, row + 0.5.
      const top = Math.max(0, Math.ceil(yTop - 0.5));
      const bottom = Math.min(subHeight - 1, Math.ceil(yBottom - 0.5) - 1);
      if (top > bottom) {
        continue;
      }
      const slope = (x2 - x1) / (y2 - y1);
      edges.push({ top, bottom, x: xTop + (top + 0.5 - yTop) * slope, slope });
    }
  }
  if (edges.length === 0) {
    return;
  }
  edges.sort((a, b) => a.top - b.top);

  let next = 0;
  let active: typeof edges = [];
  const firstRow = edges[0]?.top ?? 0;
  for (let row = firstRow; row < subHeight; row++) {
    while (next < edges.length && (edges[next]?.top ?? 0) === row) {
      const edge = edges[next];
      if (edge !== undefined) {
        active.push(edge);
      }
      next++;
    }
    active = active.filter((edge) => edge.bottom >= row);
    if (active.length === 0) {
      if (next >= edges.length) {
        return;
      }
      continue;
    }
    const crossings = active.map((edge) => edge.x).toSorted((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const start = Math.max(0, Math.ceil((crossings[i] ?? 0) - 0.5));
      const end = Math.min(
        subWidth - 1,
        Math.ceil((crossings[i + 1] ?? 0) - 0.5) - 1,
      );
      if (start <= end) {
        ids.fill(id, row * subWidth + start, row * subWidth + end + 1);
      }
    }
    for (const edge of active) {
      edge.x += edge.slope;
    }
  }
};

/** Subsamples within BORDER_HALF_WIDTH of a change of country or coastline. */
const borderMask = (
  ids: Uint16Array,
  subWidth: number,
  subHeight: number,
): Uint8Array => {
  const mask = new Uint8Array(ids.length);
  const mark = (x: number, y: number) => {
    for (let d = -BORDER_HALF_WIDTH + 1; d <= BORDER_HALF_WIDTH; d++) {
      const nx = x + d;
      if (nx >= 0 && nx < subWidth) {
        mask[y * subWidth + nx] = 1;
      }
    }
  };
  const markVertical = (x: number, y: number) => {
    for (let d = -BORDER_HALF_WIDTH + 1; d <= BORDER_HALF_WIDTH; d++) {
      const ny = y + d;
      if (ny >= 0 && ny < subHeight) {
        mask[ny * subWidth + x] = 1;
      }
    }
  };
  for (let y = 0; y < subHeight; y++) {
    for (let x = 0; x < subWidth; x++) {
      const id = ids[y * subWidth + x];
      if (x + 1 < subWidth && ids[y * subWidth + x + 1] !== id) {
        mark(x, y);
      }
      if (y + 1 < subHeight && ids[(y + 1) * subWidth + x] !== id) {
        markVertical(x, y);
      }
    }
  }
  return mask;
};

/** A white-ringed dot with a translucent halo at the map's centre. */
const drawDot = (rgb: Uint8Array): void => {
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const reach = Math.ceil(DOT.haloRadius + 1);
  for (let y = Math.floor(cy - reach); y <= Math.ceil(cy + reach); y++) {
    for (let x = Math.floor(cx - reach); x <= Math.ceil(cx + reach); x++) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const offset = (y * WIDTH + x) * 3;
      blend(
        rgb,
        offset,
        MAP_COLORS.dot,
        coverage(distance, DOT.haloRadius) * DOT.haloAlpha,
      );
      blend(rgb, offset, MAP_COLORS.ring, coverage(distance, DOT.ringRadius));
      blend(rgb, offset, MAP_COLORS.dot, coverage(distance, DOT.dotRadius));
    }
  }
};

/** Fraction of a pixel at `distance` from the centre inside `radius`. */
const coverage = (distance: number, radius: number): number =>
  clamp(radius + 0.5 - distance, 0, 1);

const blend = (rgb: Uint8Array, offset: number, color: Rgb, alpha: number) => {
  if (alpha <= 0) {
    return;
  }
  for (let channel = 0; channel < 3; channel++) {
    const current = rgb[offset + channel] ?? 0;
    rgb[offset + channel] = Math.round(
      current + ((color[channel] ?? 0) - current) * alpha,
    );
  }
};

let baseMapPromise: Promise<BaseMap> | undefined;

/** Decoded once, on the first map rendered, then kept. */
export const getBaseMap = async (): Promise<BaseMap> => {
  baseMapPromise ??= import("world-atlas/countries-50m.json").then(
    ({ default: topology }) => decodeTopology(topology),
  );
  return await baseMapPromise;
};

export type WorldAtlasTopology = {
  transform: { scale: number[]; translate: number[] };
  arcs: number[][][];
  objects: {
    countries: {
      geometries: {
        id?: string;
        arcs: unknown;
        properties: { name: string };
      }[];
    };
  };
};

/**
 * Decodes the TopoJSON countries collection: arcs are delta-encoded quantized
 * positions, and a negative arc index ~i means arc i reversed.
 */
const decodeTopology = ({
  transform: { scale, translate },
  arcs,
  objects,
}: WorldAtlasTopology): BaseMap => {
  const [scaleX = 1, scaleY = 1] = scale;
  const [translateX = 0, translateY = 0] = translate;
  const decodedArcs = arcs.map((arc) => {
    const positions = new Float64Array(arc.length * 2);
    let x = 0;
    let y = 0;
    for (const [index, [dx = 0, dy = 0]] of arc.entries()) {
      x += dx;
      y += dy;
      positions[index * 2] = x * scaleX + translateX;
      positions[index * 2 + 1] = clamp(
        y * scaleY + translateY,
        -MAX_LATITUDE,
        MAX_LATITUDE,
      );
    }
    return positions;
  });

  const ring = (arcIndexes: number[]): Float64Array => {
    const parts = arcIndexes.map((index) => {
      // A negative index is the one's complement of the reversed arc's.
      const arc =
        decodedArcs[index < 0 ? -index - 1 : index] ??
        panic(`TopoJSON arc ${index} is missing`);
      return index < 0 ? reversePositions(arc) : arc;
    });
    // Consecutive arcs share their joining position; keep it once.
    const length = parts.reduce(
      (total, part, i) => total + part.length - (i === 0 ? 0 : 2),
      0,
    );
    const positions = new Float64Array(length);
    let offset = 0;
    for (const [i, part] of parts.entries()) {
      const from = i === 0 ? part : part.subarray(2);
      positions.set(from, offset);
      offset += from.length;
    }
    return unwrapAntimeridian(positions);
  };

  const polygon = (rings: number[][]): Polygon => {
    const decoded = rings.map(ring);
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    for (const positions of decoded) {
      for (let i = 0; i < positions.length; i += 2) {
        const longitude = positions[i] ?? 0;
        const latitude = positions[i + 1] ?? 0;
        west = Math.min(west, longitude);
        east = Math.max(east, longitude);
        south = Math.min(south, latitude);
        north = Math.max(north, latitude);
      }
    }
    return { rings: decoded, west, east, south, north };
  };

  return {
    countries: objects.countries.geometries.map(
      ({ id, arcs: geometryArcs, properties: { name } }) => ({
        id: id ?? null,
        name,
        polygons: polygonArcs(geometryArcs).map(polygon),
      }),
    ),
  };
};

/** A Polygon's arcs are rings of arc indexes; a MultiPolygon's, polygons. */
const polygonArcs = (arcs: unknown): number[][][] => {
  if (isRingList(arcs)) {
    return [arcs];
  }
  if (Array.isArray(arcs) && arcs.every(isRingList)) {
    return arcs;
  }
  return panic("TopoJSON geometry is neither a Polygon nor a MultiPolygon");
};

const isRingList = (value: unknown): value is number[][] =>
  Array.isArray(value) &&
  value.every(
    (ring) =>
      Array.isArray(ring) && ring.every((index) => typeof index === "number"),
  );

/**
 * A ring that crosses the antimeridian jumps between +180 and -180; shifting
 * the far side by a whole turn keeps it one shape, which the view's whole-turn
 * offsets then place. A ring around a pole (Antarctica) does not close once
 * shifted, so it keeps its original longitudes.
 */
const unwrapAntimeridian = (positions: Float64Array): Float64Array => {
  const unwrapped = Float64Array.from(positions);
  let shift = 0;
  for (let i = 2; i < unwrapped.length; i += 2) {
    const step = (positions[i] ?? 0) - (positions[i - 2] ?? 0);
    if (step > 180) {
      shift -= 360;
    } else if (step < -180) {
      shift += 360;
    }
    unwrapped[i] = (positions[i] ?? 0) + shift;
  }
  return shift === 0 ? unwrapped : positions;
};

const reversePositions = (positions: Float64Array): Float64Array => {
  const reversed = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i += 2) {
    reversed[positions.length - 2 - i] = positions[i] ?? 0;
    reversed[positions.length - 1 - i] = positions[i + 1] ?? 0;
  }
  return reversed;
};

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_COLOR_TYPE_RGB = 2;

/**
 * Truecolour 8-bit PNG, the input format `Bun.Image` re-encodes from; every
 * row uses the Sub filter, which suits flat fills.
 */
const encodePng = ({ width, height, rgb }: Raster): Uint8Array => {
  const stride = width * 3;
  const filtered = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const source = y * stride;
    const target = y * (stride + 1);
    filtered[target] = 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? (rgb[source + x - 3] ?? 0) : 0;
      filtered[target + 1 + x] = ((rgb[source + x] ?? 0) - left + 256) % 256;
    }
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8;
  header[9] = PNG_COLOR_TYPE_RGB;
  return concatBytes([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(filtered)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
};

const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  const bytes = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};

const mercatorY = (latitude: number): number =>
  Math.log(Math.tan(Math.PI / 4 + toRadians(latitude) / 2));

const inverseMercatorY = (y: number): number =>
  ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

function hexToRgb(hex: string): Rgb {
  const channel = (start: number) =>
    Number.parseInt(hex.slice(start, start + 2), 16);
  return [channel(1), channel(3), channel(5)];
}
