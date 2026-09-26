import { describe, expect, test } from "bun:test";

import { toNormalizedEntity, toNormalizedSearchResult } from "./normalized.js";
import { parseEntity } from "./parse.js";
import type { RpoRawEntity } from "./types.js";

const readEntity = async (name: string): Promise<RpoRawEntity> => {
  const value: unknown = await Bun.file(
    new URL(`__fixtures__/${name}`, import.meta.url),
  ).json();
  // SAFETY: captured registry fixture is consumed by the defensive parser.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- committed test fixture JSON
  return value as RpoRawEntity;
};

describe("RPO normalized projection", () => {
  test("carries the source register file, capital, and people in office", async () => {
    const entity = parseEntity(await readEntity("entity-eset.json"));
    if (!entity) {
      throw new Error("ESET fixture must parse");
    }
    const normalized = toNormalizedEntity(entity);

    expect(normalized.registryId).toEqual({
      scheme: "SK-ICO",
      value: "31333532",
    });
    expect(normalized.registryRecord).toEqual({
      availability: "available",
      value: {
        courtName: "Mestský súd Bratislava III",
        section: null,
        idNumber: "Sro/3586/B",
        reference: "Sro/3586/B",
      },
    });
    expect(normalized.shareCapital).toEqual({
      availability: "available",
      // The Slovak thousands separator is a no-break space.
      value: { text: "140\u00A0000 EUR", amount: "140000", currency: "EUR" },
    });
    expect(normalized.status).toEqual({
      availability: "available",
      value: { type: "active" },
    });
    if (normalized.keyPeople.availability !== "available") {
      throw new Error("key people must be available");
    }
    expect(normalized.keyPeople.value.map(({ name }) => name)).toEqual([
      "Konateľ",
      "Spoločník v.o.s. / s.r.o.",
      "Člen dozorného orgánu",
    ]);
  });

  test("keeps only people in office from a historical record", async () => {
    const entity = parseEntity(await readEntity("entity-eset-historical.json"));
    if (!entity) {
      throw new Error("ESET fixture must parse");
    }
    const inOffice = [...entity.statutoryBodies, ...entity.stakeholders].filter(
      ({ validTo }) => validTo === null,
    );
    expect(inOffice.length).toBeLessThan(
      entity.statutoryBodies.length + entity.stakeholders.length,
    );

    const normalized = toNormalizedEntity(entity);
    if (normalized.keyPeople.availability !== "available") {
      throw new Error("key people must be available");
    }
    expect(
      normalized.keyPeople.value.flatMap(({ people }) => people).length,
    ).toBe(inOffice.length);
  });

  test("projects an IČO that predates the check digit", () => {
    const result = toNormalizedSearchResult({
      rpoId: 583_012,
      ico: "11111111",
      name: "Stredoslovenské riaditeľstvo telekomunikácií Banská Bystrica",
      address: null,
      sourceRegister: "Obchodný register",
      status: { type: "terminated", terminatedAt: "1992-12-31" },
    });

    expect(result.registryId.value).toBe("11111111");
    expect(result.status).toEqual({
      availability: "available",
      value: { type: "dissolved" },
    });
    expect(result.registryUrl).toEqual({
      availability: "available",
      value: "https://api.statistics.sk/rpo/v1/entity/583012",
    });
  });
});
