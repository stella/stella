import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { readViewerLocation } from "@/api/lib/auth/viewer-location";
import { CLIENT_ADDRESS_SOURCE, type ClientAddress } from "@/api/lib/client-ip";

const CLOUDFRONT_ADDRESS_HEADER = "cloudfront-viewer-address";

// The names CloudFront documents; the module under test keeps its own copy
// private so that it stays their only reader.
const VIEWER_LOCATION_HEADERS = {
  country: "cloudfront-viewer-country",
  region: "cloudfront-viewer-country-region-name",
  city: "cloudfront-viewer-city",
  latitude: "cloudfront-viewer-latitude",
  longitude: "cloudfront-viewer-longitude",
} as const;

// CloudFront's list of the header names the viewer itself sent.
const VIEWER_HEADER_LIST_HEADERS = {
  order: "cloudfront-viewer-header-order",
  count: "cloudfront-viewer-header-count",
} as const;

const ORDINARY_VIEWER_HEADERS = ["Host", "User-Agent", "Accept"] as const;

type ViewerHeaderList = { order: string; count: string };

const viewerHeaderList = (names: readonly string[]): ViewerHeaderList => ({
  order: names.join(":"),
  count: String(names.length),
});

/** Adds CloudFront's list of the viewer's own header names. */
const withViewerHeaderList = (
  headers: Headers,
  { order, count }: ViewerHeaderList = viewerHeaderList(
    ORDINARY_VIEWER_HEADERS,
  ),
): Headers => {
  const listed = new Headers(headers);
  listed.set(VIEWER_HEADER_LIST_HEADERS.order, order);
  listed.set(VIEWER_HEADER_LIST_HEADERS.count, count);
  return listed;
};

const readThroughCloudFront = (headers: Headers, list?: ViewerHeaderList) =>
  readViewerLocation({
    headers: withViewerHeaderList(headers, list),
    clientAddress: {
      address: "198.51.100.7",
      source: CLIENT_ADDRESS_SOURCE.edgeHeader,
    },
    edgeHeader: CLOUDFRONT_ADDRESS_HEADER,
  });

const PRAGUE_HEADERS = {
  [VIEWER_LOCATION_HEADERS.country]: "CZ",
  [VIEWER_LOCATION_HEADERS.region]: "Hlavni mesto Praha",
  [VIEWER_LOCATION_HEADERS.city]: "Prague",
  [VIEWER_LOCATION_HEADERS.latitude]: "50.08804",
  [VIEWER_LOCATION_HEADERS.longitude]: "14.42076",
};

describe("reading the headers CloudFront sends", () => {
  test("reads every field the edge sends", () => {
    expect(readThroughCloudFront(new Headers(PRAGUE_HEADERS))).toEqual({
      type: "known",
      countryCode: "CZ",
      region: "Hlavni mesto Praha",
      city: "Prague",
      coordinates: { latitude: 50.1, longitude: 14.4 },
    });
  });

  test("decodes the percent-encoded non-ASCII characters CloudFront sends", () => {
    const location = readThroughCloudFront(
      new Headers({
        ...PRAGUE_HEADERS,
        [VIEWER_LOCATION_HEADERS.country]: "CH",
        [VIEWER_LOCATION_HEADERS.city]: "Z%C3%BCrich",
        [VIEWER_LOCATION_HEADERS.region]: "Z%C3%BCrich",
      }),
    );
    expect(location).toMatchObject({ city: "Zürich", region: "Zürich" });
  });

  test.each([undefined, "", "ZZ", "A1", "Czechia"])(
    "a missing or non-ISO country %j makes the location unknown",
    (country) => {
      const headers = new Headers(PRAGUE_HEADERS);
      headers.delete(VIEWER_LOCATION_HEADERS.country);
      if (country !== undefined) {
        headers.set(VIEWER_LOCATION_HEADERS.country, country);
      }
      expect(readThroughCloudFront(headers)).toEqual({ type: "unknown" });
    },
  );

  test("normalizes the country code's case", () => {
    expect(
      readThroughCloudFront(
        new Headers({ [VIEWER_LOCATION_HEADERS.country]: "sk" }),
      ),
    ).toEqual({
      type: "known",
      countryCode: "SK",
      region: null,
      city: null,
      coordinates: null,
    });
  });

  test.each([
    ["latitude out of range", { latitude: "90.5" }],
    ["longitude out of range", { longitude: "-180.01" }],
    ["exponent notation", { latitude: "5e1" }],
    ["not a number", { longitude: "east" }],
    ["latitude missing", { latitude: null }],
  ])("drops the coordinates on %s, keeping the place", (_, change) => {
    const headers = new Headers(PRAGUE_HEADERS);
    for (const [field, value] of Object.entries(change)) {
      const name =
        field === "latitude"
          ? VIEWER_LOCATION_HEADERS.latitude
          : VIEWER_LOCATION_HEADERS.longitude;
      if (value === null) {
        headers.delete(name);
      } else {
        headers.set(name, value);
      }
    }
    expect(readThroughCloudFront(headers)).toMatchObject({
      type: "known",
      city: "Prague",
      coordinates: null,
    });
  });

  test.each([
    ["malformed percent-encoding", "%E0%A4%A"],
    ["an encoded control character", "Prague%0Aevil"],
    ["only whitespace", "   "],
    ["an implausibly long name", "a".repeat(101)],
  ])("drops a city with %s", (_, city) => {
    expect(
      readThroughCloudFront(
        new Headers({
          ...PRAGUE_HEADERS,
          [VIEWER_LOCATION_HEADERS.city]: city,
        }),
      ),
    ).toMatchObject({
      type: "known",
      city: null,
      region: "Hlavni mesto Praha",
    });
  });

  test("never yields a place name with control characters or over 100 characters", () => {
    assertProperty(
      "never yields a place name with control characters or over 100 characters",
      fc.property(
        fc.string({ unit: "binary", maxLength: 160 }),
        fc.string({ unit: "binary", maxLength: 160 }),
        (city, region) => {
          const headers = new Headers({
            [VIEWER_LOCATION_HEADERS.country]: "CZ",
          });
          // Header values are ByteStrings; percent-encode as the edge does.
          headers.set(VIEWER_LOCATION_HEADERS.city, encodeURIComponent(city));
          headers.set(VIEWER_LOCATION_HEADERS.region, encodeURI(region));
          const location = readThroughCloudFront(headers);
          if (location.type !== "known") {
            return false;
          }
          return [location.city, location.region].every(
            (name) =>
              name === null ||
              (name.length > 0 && name.length <= 100 && !/\p{Cc}/u.test(name)),
          );
        },
      ),
    );
  });
});

describe("viewer-sent location headers", () => {
  const VIEWER_HEADER_NAMES = [
    ...Object.values(VIEWER_LOCATION_HEADERS),
    "cloudfront-viewer-address",
    "cloudfront-viewer-asn",
  ];

  test("keeps the location when the viewer sent only ordinary headers", () => {
    expect(readThroughCloudFront(new Headers(PRAGUE_HEADERS))).toMatchObject({
      type: "known",
      city: "Prague",
    });
  });

  test("a city the viewer sent itself makes the whole location unknown", () => {
    expect(
      readThroughCloudFront(
        new Headers(PRAGUE_HEADERS),
        viewerHeaderList(["Host", "CloudFront-Viewer-City", "Accept"]),
      ),
    ).toEqual({ type: "unknown" });
  });

  test("a viewer-sent cloudfront-viewer header in any case and position makes the location unknown", () => {
    assertProperty(
      "a viewer-sent cloudfront-viewer header in any case and position makes the location unknown",
      fc.property(
        fc.constantFrom(...VIEWER_HEADER_NAMES),
        fc.array(fc.boolean(), { minLength: 40, maxLength: 40 }),
        fc.nat({ max: ORDINARY_VIEWER_HEADERS.length }),
        (name, upper, position) => {
          const cased = [...name]
            .map((char, index) => (upper[index] ? char.toUpperCase() : char))
            .join("");
          const names: string[] = [...ORDINARY_VIEWER_HEADERS];
          names.splice(position, 0, cased);
          return (
            readThroughCloudFront(
              new Headers(PRAGUE_HEADERS),
              viewerHeaderList(names),
            ).type === "unknown"
          );
        },
      ),
    );
  });

  test.each([
    ["the count exceeds the listed names", "Host:Accept", "5"],
    ["the count is below the listed names", "Host:Accept:User-Agent", "2"],
    ["the count is not a number", "Host:Accept", "two"],
    ["the count is negative", "Host:Accept", "-2"],
  ])("is unknown when %s", (_, order, count) => {
    expect(
      readThroughCloudFront(new Headers(PRAGUE_HEADERS), { order, count }),
    ).toEqual({ type: "unknown" });
  });

  test.each([
    ["header list", VIEWER_HEADER_LIST_HEADERS.order],
    ["header count", VIEWER_HEADER_LIST_HEADERS.count],
  ])("is unknown when CloudFront sent no viewer %s", (_, missing) => {
    const headers = withViewerHeaderList(new Headers(PRAGUE_HEADERS));
    headers.delete(missing);
    expect(
      readViewerLocation({
        headers,
        clientAddress: {
          address: "198.51.100.7",
          source: CLIENT_ADDRESS_SOURCE.edgeHeader,
        },
        edgeHeader: CLOUDFRONT_ADDRESS_HEADER,
      }),
    ).toEqual({ type: "unknown" });
  });
});

describe("readViewerLocation", () => {
  const request = new Request("https://api.example.test/api/auth/sign-in", {
    headers: withViewerHeaderList(new Headers(PRAGUE_HEADERS)),
  });
  const address = (source: ClientAddress["source"]): ClientAddress => ({
    address: "198.51.100.7",
    source,
  });

  test("trusts the headers on a request the CloudFront address came from", () => {
    expect(
      readViewerLocation({
        headers: request.headers,
        clientAddress: address(CLIENT_ADDRESS_SOURCE.edgeHeader),
        edgeHeader: CLOUDFRONT_ADDRESS_HEADER,
      }),
    ).toMatchObject({ type: "known", city: "Prague" });
  });

  test.each([
    [
      "the socket peer",
      address(CLIENT_ADDRESS_SOURCE.peer),
      CLOUDFRONT_ADDRESS_HEADER,
    ],
    [
      "an x-forwarded-for chain",
      address(CLIENT_ADDRESS_SOURCE.forwardedFor),
      CLOUDFRONT_ADDRESS_HEADER,
    ],
    [
      "a proxy header that needs no origin proof",
      address(CLIENT_ADDRESS_SOURCE.edgeHeader),
      "x-real-client-ip",
    ],
    ["no resolved address", null, CLOUDFRONT_ADDRESS_HEADER],
  ])(
    "ignores the same headers when the address came from %s",
    (_, clientAddress, edgeHeader) => {
      expect(
        readViewerLocation({
          headers: request.headers,
          clientAddress,
          edgeHeader,
        }),
      ).toEqual({ type: "unknown" });
    },
  );

  test("is unknown without headers", () => {
    expect(
      readViewerLocation({
        headers: undefined,
        clientAddress: address(CLIENT_ADDRESS_SOURCE.edgeHeader),
        edgeHeader: CLOUDFRONT_ADDRESS_HEADER,
      }),
    ).toEqual({ type: "unknown" });
  });
});
