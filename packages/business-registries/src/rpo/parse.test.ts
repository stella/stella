import { describe, expect, test } from "bun:test";

import { parseAddress, parseEntity, parseSearchHit } from "./parse.js";
import type { RpoRawEntity, RpoRawSearchResponse } from "./types.js";

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);

// SAFETY: fixtures are captured from the live RPO API and committed beside
// the tests; the assertions below check the parsed shape.
const readFixture = async <T>(name: string): Promise<T> =>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- committed test fixture JSON; shape asserted by the tests below
  (await Bun.file(new URL(name, FIXTURE_DIR)).json()) as T;

describe("parseEntity", () => {
  test("reads the current record of a limited liability company", async () => {
    const entity = parseEntity(
      await readFixture<RpoRawEntity>("entity-eset.json"),
    );

    expect(entity).toMatchObject({
      ico: "31333532",
      name: "ESET, spol. s r.o.",
      legalForm: { code: "112", label: "Spoločnosť s ručením obmedzeným" },
      address: {
        street: "Einsteinova 24",
        postalCode: "851 01",
        city: "Bratislava",
      },
      establishedAt: "1992-09-17",
      terminatedAt: null,
      status: { type: "active" },
      sourceRegister: {
        name: "Obchodný register",
        registrationOffice: "Mestský súd Bratislava III",
        registrationNumber: "Sro/3586/B",
      },
      shareCapital: { amount: 140_000, currency: "EUR" },
      shareCapitalPaid: { amount: 140_000, currency: "EUR" },
      registryUrl: "https://api.statistics.sk/rpo/v1/entity/937053",
    });
    expect(entity?.statutoryBodies.map(({ name }) => name)).toEqual([
      "Ing. Richard Marko",
      "Ing. Miroslav Trnka",
      "Ing. Peter Paško",
    ]);
    expect(
      entity?.statutoryBodies.every(({ organName }) => organName === "Konateľ"),
    ).toBe(true);
    expect(entity?.predecessors.map(({ ico }) => ico)).toEqual([
      "46498940",
      "35889691",
    ]);
    expect(entity?.authorizations.at(0)?.value).toStartWith(
      "V mene spoločnosti",
    );
  });

  test("the historical view adds closed records to the ones in force", async () => {
    const current = parseEntity(
      await readFixture<RpoRawEntity>("entity-eset.json"),
    );
    const historical = parseEntity(
      await readFixture<RpoRawEntity>("entity-eset-historical.json"),
    );
    if (current === null || historical === null) {
      throw new Error("ESET fixtures must parse");
    }

    const key = (person: { name: string; organName: string | null }) =>
      `${person.name}|${person.organName ?? ""}`;
    const openInHistory = historical.statutoryBodies
      .filter(({ validTo }) => validTo === null)
      .map(key);
    expect(openInHistory.toSorted()).toEqual(
      current.statutoryBodies.map(key).toSorted(),
    );
    expect(
      historical.statutoryBodies.some(({ validTo }) => validTo !== null),
    ).toBe(true);
    expect(historical.stakeholders.length).toBeGreaterThan(
      current.stakeholders.length,
    );
    // Records in force sort ahead of closed ones.
    const firstClosed = historical.statutoryBodies.findIndex(
      ({ validTo }) => validTo !== null,
    );
    expect(
      historical.statutoryBodies
        .slice(firstClosed)
        .every(({ validTo }) => validTo !== null),
    ).toBe(true);
  });

  test("reads a public body outside the commercial register", async () => {
    const entity = parseEntity(
      await readFixture<RpoRawEntity>("entity-public-university.json"),
    );

    expect(entity).toMatchObject({
      ico: "00397865",
      name: "Univerzita Komenského v Bratislave",
      legalForm: { code: "382", label: "Verejnoprávna inštitúcia" },
      sourceRegister: {
        name: "Register vysokých škôl",
        registrationNumber: "701000000",
      },
      shareCapital: null,
      // "Bez záznamu" states that no legal-status note is on file.
      legalStatuses: [],
    });
    // The rector's name arrives as given and family names only.
    expect(entity?.statutoryBodies).toEqual([
      expect.objectContaining({
        name: "Marek Števček",
        organName: "Rektor",
        address:
          "Dunajská 2312/22, 811 08 Bratislava - mestská časť Staré Mesto, Slovenská republika",
      }),
    ]);
  });

  test("a terminated entity's current view has no name of its own", async () => {
    const raw = await readFixture<RpoRawEntity>("entity-terminated.json");
    expect(raw.termination).toBe("2023-07-05");
    expect(raw.fullNames).toEqual([]);
    expect(parseEntity(raw)).toBeNull();
  });
});

describe("parseAddress", () => {
  test("writes Slovak postal codes as DDD DD and keeps foreign ones", () => {
    for (const raw of ["85101", "851 01", " 85101 "]) {
      expect(
        parseAddress({
          postalCodes: [raw],
          country: { code: "703", value: "Slovenská republika" },
        }).postalCode,
      ).toBe("851 01");
    }
    expect(
      parseAddress({
        street: "Kányakapu str",
        buildingNumber: "10",
        postalCodes: ["H-1112"],
        municipality: { value: "Budapešť" },
        country: { code: "348", value: "Maďarsko" },
      }),
    ).toEqual({
      street: "Kányakapu str 10",
      postalCode: "H-1112",
      city: "Budapešť",
      country: "Maďarsko",
      textAddress: "Kányakapu str 10, H-1112 Budapešť, Maďarsko",
    });
  });

  test("numbers houses in a village without street names by the village", () => {
    expect(
      parseAddress({
        regNumber: 123,
        postalCodes: ["90201"],
        municipality: { value: "Vinosady" },
      }).street,
    ).toBe("Vinosady 123");
  });
});

describe("parseSearchHit", () => {
  test("parses every row of a name search and reads termination", async () => {
    const { results } = await readFixture<RpoRawSearchResponse>(
      "search-by-name-slovnaft.json",
    );
    const parsed = results.map(parseSearchHit);

    expect(parsed.length).toBeGreaterThan(0);
    for (const [index, result] of parsed.entries()) {
      const raw = results[index];
      expect(result).not.toBeNull();
      expect(result?.status.type).toBe(
        raw?.termination === undefined ? "active" : "terminated",
      );
    }
    expect(parsed).toContainEqual(
      expect.objectContaining({
        rpoId: 297_265,
        ico: "35681039",
        name: "Slovnaft Retail, s.r.o.",
        status: { type: "terminated", terminatedAt: "2023-07-05" },
      }),
    );
  });
});
