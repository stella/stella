import { Result } from "better-result";

import { parseDecimalToken } from "@stll/agent-input/numeric-token";
import { type CountryCode, isCountryCode } from "@stll/country-codes";
import type { GeoPoint } from "@stll/transactional/map/location-map";

import {
  type ClientAddress,
  isCloudFrontVerifiedAddress,
} from "@/api/lib/client-ip";
import { VIEWER_COUNTRY_HEADER } from "@/api/lib/detected-country";

/**
 * The geolocation headers CloudFront adds from the viewer's IP address (the
 * distribution's origin request policy forwards them). Nothing is looked up
 * here: the edge has already resolved the address, and no other service sees
 * it.
 */
export const VIEWER_LOCATION_HEADERS = {
  country: VIEWER_COUNTRY_HEADER,
  region: "cloudfront-viewer-country-region-name",
  city: "cloudfront-viewer-city",
  latitude: "cloudfront-viewer-latitude",
  longitude: "cloudfront-viewer-longitude",
} as const;

/**
 * Where a request came from, as approximate as IP geolocation is. Held only
 * for the request that produced it; never stored.
 */
export type ViewerLocation =
  | { type: "unknown" }
  | {
      type: "known";
      countryCode: CountryCode;
      region: string | null;
      city: string | null;
      coordinates: GeoPoint | null;
    };

const UNKNOWN_LOCATION = { type: "unknown" } as const satisfies ViewerLocation;

type ReadViewerLocationOptions = {
  request: Request | undefined;
  /** The request's resolved address; it decides whether the edge is trusted. */
  clientAddress: ClientAddress | null | undefined;
  /** The configured edge address header; defaults to the environment's. */
  edgeHeader?: string | null | undefined;
};

/**
 * The location CloudFront reported for this request, or `unknown` unless the
 * request provably came through CloudFront: anyone reaching the API another
 * way can send the same headers with any value, and a security notice must not
 * show a location the signer-in chose.
 */
export const readViewerLocation = ({
  request,
  clientAddress,
  edgeHeader,
}: ReadViewerLocationOptions): ViewerLocation =>
  request !== undefined &&
  isCloudFrontVerifiedAddress(clientAddress, edgeHeader)
    ? parseViewerLocation(request.headers)
    : UNKNOWN_LOCATION;

/**
 * Reads the geolocation headers. A country is required; city, region and
 * coordinates are each dropped on their own when absent or malformed, since
 * CloudFront omits what it cannot resolve for an address.
 */
export const parseViewerLocation = (headers: Headers): ViewerLocation => {
  const country = headers
    .get(VIEWER_LOCATION_HEADERS.country)
    ?.trim()
    .toUpperCase();
  if (country === undefined || !isCountryCode(country)) {
    return UNKNOWN_LOCATION;
  }
  const latitude = parseCoordinate(
    headers.get(VIEWER_LOCATION_HEADERS.latitude),
    MAX_LATITUDE,
  );
  const longitude = parseCoordinate(
    headers.get(VIEWER_LOCATION_HEADERS.longitude),
    MAX_LONGITUDE,
  );
  return {
    type: "known",
    countryCode: country,
    region: parsePlaceName(headers.get(VIEWER_LOCATION_HEADERS.region)),
    city: parsePlaceName(headers.get(VIEWER_LOCATION_HEADERS.city)),
    coordinates:
      latitude === null || longitude === null ? null : { latitude, longitude },
  };
};

const MAX_LATITUDE = 90;
const MAX_LONGITUDE = 180;
const MAX_PLACE_NAME_LENGTH = 100;
/**
 * Coordinates keep one decimal (about 11 km): the map is regional, so finer
 * precision would show nothing more and only carry more personal data.
 */
const COORDINATE_PRECISION = 10;
const CONTROL_CHARACTER = /\p{Cc}/u;

/** CloudFront percent-encodes non-ASCII characters in these values. */
const parsePlaceName = (raw: string | null): string | null => {
  if (raw === null) {
    return null;
  }
  const decoded = Result.try(() => decodeURIComponent(raw));
  if (Result.isError(decoded)) {
    return null;
  }
  const name = decoded.value.trim();
  return name.length === 0 ||
    name.length > MAX_PLACE_NAME_LENGTH ||
    CONTROL_CHARACTER.test(name)
    ? null
    : name;
};

const parseCoordinate = (raw: string | null, limit: number): number | null => {
  const value = parseDecimalToken(raw?.trim(), { min: -limit, max: limit });
  return Result.isError(value)
    ? null
    : Math.round(value.value * COORDINATE_PRECISION) / COORDINATE_PRECISION;
};
