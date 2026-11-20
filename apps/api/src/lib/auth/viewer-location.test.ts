import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  parseViewerLocation,
  readViewerLocation,
  VIEWER_LOCATION_HEADERS,
} from "@/api/lib/auth/viewer-location";
import { CLIENT_ADDRESS_SOURCE, type ClientAddress } from "@/api/lib/client-ip";

const CLOUDFRONT_ADDRESS_HEADER = "cloudfront-viewer-address";

const PRAGUE_HEADERS = {
  [VIEWER_LOCATION_HEADERS.country]: "CZ",
  [VIEWER_LOCATION_HEADERS.region]: "Hlavni mesto Praha",
  [VIEWER_LOCATION_HEADERS.city]: "Prague",
  [VIEWER_LOCATION_HEADERS.latitude]: "50.08804",
  [VIEWER_LOCATION_HEADERS.longitude]: "14.42076",
};

describe("parseViewerLocation", () => {
  test("reads every field the edge sends", () => {
    expect(parseViewerLocation(new Headers(PRAGUE_HEADERS))).toEqual({
      type: "known",
      countryCode: "CZ",
      region: "Hlavni mesto Praha",
      city: "Prague",
      coordinates: { latitude: 50.1, longitude: 14.4 },
    });
  });

  test("decodes the percent-encoded non-ASCII characters CloudFront sends", () => {
    const location = parseViewerLocation(
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
      expect(parseViewerLocation(headers)).toEqual({ type: "unknown" });
    },
  );

  test("normalizes the country code's case", () => {
    expect(
      parseViewerLocation(
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
    expect(parseViewerLocation(headers)).toMatchObject({
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
      parseViewerLocation(
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
      "viewer-location place names are bounded and printable",
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
          const location = parseViewerLocation(headers);
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

describe("readViewerLocation", () => {
  const request = new Request("https://api.example.test/api/auth/sign-in", {
    headers: PRAGUE_HEADERS,
  });
  const address = (source: ClientAddress["source"]): ClientAddress => ({
    address: "198.51.100.7",
    source,
  });

  test("trusts the headers on a request the CloudFront address came from", () => {
    expect(
      readViewerLocation({
        request,
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
        readViewerLocation({ request, clientAddress, edgeHeader }),
      ).toEqual({ type: "unknown" });
    },
  );

  test("is unknown without a request", () => {
    expect(
      readViewerLocation({
        request: undefined,
        clientAddress: address(CLIENT_ADDRESS_SOURCE.edgeHeader),
        edgeHeader: CLOUDFRONT_ADDRESS_HEADER,
      }),
    ).toEqual({ type: "unknown" });
  });
});
