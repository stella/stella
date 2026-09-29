import { describe, expect, test } from "bun:test";

import {
  CENTRAL_EUROPE_GLOBE_FRAME,
  coverageGlobeFrame,
  orderCoverageCountriesByName,
} from "@/routes/law/-law-coverage/coverage.logic";

describe("countries are ordered by the name the reader sees", () => {
  test("the reader's collation decides, not the ISO code", () => {
    // Codepoint order would give AUT, CZE, HUN; a Czech reader reads the
    // names, where "Ch" is a letter of its own sitting between H and I.
    const countries = [
      { country: "AUT", name: "Itálie" },
      { country: "CZE", name: "Chorvatsko" },
      { country: "HUN", name: "Haiti" },
    ];

    expect(
      orderCoverageCountriesByName({
        countries,
        locale: "cs",
        nameOf: ({ name }) => name,
      }).map(({ country }) => country),
    ).toEqual(["HUN", "CZE", "AUT"]);
  });

  test("the same names order differently under a different locale", () => {
    const countries = [
      { country: "AUT", name: "Itálie" },
      { country: "CZE", name: "Chorvatsko" },
      { country: "HUN", name: "Haiti" },
    ];

    expect(
      orderCoverageCountriesByName({
        countries,
        locale: "en",
        nameOf: ({ name }) => name,
      }).map(({ country }) => country),
    ).toEqual(["CZE", "HUN", "AUT"]);
  });

  test("the input is left untouched", () => {
    const countries = [{ country: "POL" }, { country: "AUT" }];

    orderCoverageCountriesByName({
      countries,
      locale: "en",
      nameOf: ({ country }) => country,
    });

    expect(countries.map(({ country }) => country)).toEqual(["POL", "AUT"]);
  });
});

describe("the coverage globe shows every capital it pins", () => {
  const EUROPE: readonly (readonly [number, number])[] = [
    [48.21, 16.37],
    [50.08, 14.44],
    [49.61, 6.13],
    [47.5, 19.04],
    [52.23, 21.01],
    [48.15, 17.11],
  ];
  const WASHINGTON = [38.89, -77] as const;

  /** A place's distance from the disc's centre, as a share of its radius. */
  const onDisc = (
    frame: ReturnType<typeof coverageGlobeFrame>,
    [latitude, longitude]: readonly [number, number],
  ): number => {
    const toVector = (lat: number, lon: number) => {
      const [a, b] = [(lat * Math.PI) / 180, (lon * Math.PI) / 180];
      return [
        Math.cos(a) * Math.cos(b),
        Math.cos(a) * Math.sin(b),
        Math.sin(a),
      ];
    };
    const centre = toVector((frame.tilt * 180) / Math.PI, frame.longitude);
    const place = toVector(latitude, longitude);
    let cosine = 0;
    for (const [index, value] of centre.entries()) {
      cosine += value * (place[index] ?? 0);
    }
    return cosine <= 0
      ? Number.POSITIVE_INFINITY
      : frame.scale * Math.sqrt(1 - cosine ** 2);
  };

  test("Central Europe keeps its close framing while it holds every pin", () => {
    expect(coverageGlobeFrame(EUROPE)).toEqual(CENTRAL_EUROPE_GLOBE_FRAME);
  });

  test("a capital outside Central Europe turns and widens the globe until it shows", () => {
    const places = [...EUROPE, WASHINGTON];
    // The close framing loses it: the case the derived frame exists for.
    expect(onDisc(CENTRAL_EUROPE_GLOBE_FRAME, WASHINGTON)).toBeGreaterThan(1);

    const frame = coverageGlobeFrame(places);
    for (const place of places) {
      expect(onDisc(frame, place)).toBeLessThanOrEqual(0.9 + 1e-9);
    }
  });
});
