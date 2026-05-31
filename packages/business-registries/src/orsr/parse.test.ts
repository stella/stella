import { describe, expect, test } from "bun:test";

import { parseAddress, parseExtract, parseSearchHit } from "./parse.js";
import type {
  OrsrRawAddress,
  OrsrRawExtractResponse,
  OrsrRawSearchHit,
} from "./types.js";

const readFixture = async <T>(name: string): Promise<T> => {
  const url = new URL(`__fixtures__/${name}`, import.meta.url);
  // SAFETY: fixtures are captured directly from the live API.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return (await Bun.file(url).json()) as T;
};

describe("parseAddress", () => {
  test("composes a Slovak address with DDD DD postal-code formatting", () => {
    const raw: OrsrRawAddress = {
      streetName: "Einsteinova",
      buildingNumber: "24",
      country: { item: { codelistItem: { itemName: "Slovenská republika" } } },
      municipality: { item: { codelistItem: { itemName: "Bratislava" } } },
      deliveryAddress: { postalCode: "85101" },
    };
    const parsed = parseAddress(raw);
    expect(parsed.street).toBe("Einsteinova 24");
    expect(parsed.postalCode).toBe("851 01");
    expect(parsed.city).toBe("Bratislava");
    expect(parsed.country).toBe("Slovenská republika");
    expect(parsed.textAddress).toBe(
      "Einsteinova 24, 851 01 Bratislava, Slovenská republika",
    );
  });

  test("keeps foreign postal codes untouched", () => {
    const raw: OrsrRawAddress = {
      streetName: "Wenceslas Square",
      buildingNumber: "1",
      country: { item: { codelistItem: { itemName: "Česká republika" } } },
      municipality: { item: { codelistItem: { itemName: "Praha" } } },
      deliveryAddress: { postalCode: "11000" },
    };
    expect(parseAddress(raw).postalCode).toBe("11000");
  });

  test("emits null fields when address atoms are absent", () => {
    expect(parseAddress({})).toEqual({
      street: null,
      postalCode: null,
      city: null,
      country: null,
      textAddress: null,
    });
  });

  test("joins property and building numbers with a slash", () => {
    // Slovak addresses sometimes carry both súpisné and orientačné
    // numbers; render them in the canonical `súpisné/orientačné` order.
    const parsed = parseAddress({
      streetName: "Bajkalská",
      buildingNumber: "5/C",
      propertyRegistrationNumber: "9999",
      deliveryAddress: { postalCode: "83104" },
      country: { item: { codelistItem: { itemName: "Slovenská republika" } } },
    });
    expect(parsed.street).toBe("Bajkalská 9999/5/C");
  });
});

describe("parseExtract (ESET)", () => {
  test("maps the canonical ESET payload to the domain shape", async () => {
    const raw = await readFixture<OrsrRawExtractResponse>("extract-eset.json");
    const company = parseExtract(raw);
    expect(company).not.toBeNull();
    if (!company) {
      return;
    }
    expect(company.ico).toBe("31333532");
    expect(company.name).toBe("ESET, spol. s r.o.");
    expect(company.legalForm).toBe("Spoločnosť s ručením obmedzeným");
    expect(company.address?.street).toBe("Einsteinova 24");
    expect(company.address?.postalCode).toBe("851 01");
    expect(company.address?.city).toBe("Bratislava");
    expect(company.courtFile).toEqual({
      court: "B",
      section: "Sro",
      insertNumber: "3586",
    });
    expect(company.status).toEqual({ type: "active" });
    expect(company.terminatedAt).toBeNull();
    expect(company.establishedAt).toBe("1992-09-17T00:00:00");
    // Slovak number formatting uses U+00A0 (non-breaking space) as
    // the thousands separator — match it exactly so the test catches
    // regressions to a regular space.
    expect(company.shareCapital).toBe("140 000 EUR");
    expect(company.shareCapitalPaid).toBe("140 000 EUR");
    expect(company.actingClause).toContain("V mene spoločnosti");
    expect(company.registryUrl).toBe(
      "https://sluzby.orsr.sk/Subjekt?oddiel=Sro&vlozka=3586&sud=B",
    );
  });

  test("collects statutory body members with mapped position", async () => {
    const raw = await readFixture<OrsrRawExtractResponse>("extract-eset.json");
    const company = parseExtract(raw);
    expect(company?.statutoryBodies.length).toBe(1);
    const board = company?.statutoryBodies.at(0);
    expect(board?.organName).toBe("Štatutárny orgán");
    const names = board?.members.map((member) => member.name) ?? [];
    expect(names).toContain("Ing. Peter Paško");
    expect(names).toContain("Ing. Miroslav Trnka");
    expect(names).toContain("Ing. Richard Marko");
    const richard = board?.members.find(
      (member) => member.name === "Ing. Richard Marko",
    );
    expect(richard?.position).toBe("Konatelia");
  });

  test("maps Spoločník and Predchodca stakeholders with shares", async () => {
    const raw = await readFixture<OrsrRawExtractResponse>("extract-eset.json");
    const company = parseExtract(raw);
    const partners = company?.stakeholders.filter(
      (item) => item.organName === "Spoločníci",
    );
    expect(partners?.length).toBeGreaterThan(0);
    const peter = partners?.find((item) => item.name === "Ing. Peter Paško");
    expect(peter?.position).toBe("Spoločník");
    expect(peter?.share).toContain("Výška vkladu");
    expect(peter?.share).toContain("EUR");

    const predecessors = company?.stakeholders.filter(
      (item) => item.organName === "Právny predchodca",
    );
    expect(predecessors?.length).toBeGreaterThan(0);
    expect(predecessors?.[0]?.identifier).toMatch(/^\d+$/u);
  });

  test("filters out non-current stakeholders", async () => {
    const raw = await readFixture<OrsrRawExtractResponse>("extract-eset.json");
    // Flip every stakeholder's `current` flag off and confirm none surface.
    for (const member of raw.legalPerson?.corporateBody?.stakeholder ?? []) {
      member.current = false;
    }
    const company = parseExtract(raw);
    expect(company?.stakeholders).toEqual([]);
  });
});

describe("parseExtract status branches", () => {
  test("surfaces termination as terminated status", async () => {
    const raw = await readFixture<OrsrRawExtractResponse>("extract-eset.json");
    if (raw.legalPerson?.corporateBody) {
      raw.legalPerson.corporateBody.termination = "2020-01-15T00:00:00";
    }
    const company = parseExtract(raw);
    expect(company?.status).toEqual({
      type: "terminated",
      terminatedAt: "2020-01-15T00:00:00",
    });
    expect(company?.terminatedAt).toBe("2020-01-15T00:00:00");
  });

  test("ignores the 0001 sentinel termination date", async () => {
    const raw = await readFixture<OrsrRawExtractResponse>("extract-eset.json");
    if (raw.legalPerson?.corporateBody) {
      raw.legalPerson.corporateBody.termination = "0001-01-01T00:00:00";
    }
    expect(parseExtract(raw)?.status).toEqual({ type: "active" });
  });

  test("preserves the last filed roster for terminated entities", async () => {
    // When a company is dissolved, the upstream stops marking
    // statutory-body / stakeholder rows as `current`. The parser
    // should still surface the last filed roster — i.e. members who
    // were in office at the point of dissolution (no
    // `functionTerminationDate` or a 0001 sentinel) — and NOT every
    // historical row ever recorded.
    const raw = await readFixture<OrsrRawExtractResponse>("extract-eset.json");
    if (raw.legalPerson?.corporateBody) {
      raw.legalPerson.corporateBody.termination = "2020-01-15T00:00:00";
      for (const member of raw.legalPerson.corporateBody.statutoryBody ?? []) {
        member.current = false;
      }
      for (const member of raw.legalPerson.corporateBody.stakeholder ?? []) {
        member.current = false;
      }
    }
    const company = parseExtract(raw);
    expect(company?.statutoryBodies.length).toBeGreaterThan(0);
    expect(company?.statutoryBodies[0]?.members.length).toBeGreaterThan(0);
    expect(company?.stakeholders.length).toBeGreaterThan(0);
  });

  test("preserves the statutory body type on terminated entities", async () => {
    // The `statutoryBodyType` is a temporal record too. When the
    // company terminates, every `current` flag flips false; reading
    // the type via `pickCurrent` alone produces null, and downstream
    // emits `position: null` on every preserved officer instead of
    // the last filed body type (e.g. "konatelia").
    const raw = await readFixture<OrsrRawExtractResponse>("extract-eset.json");
    if (raw.legalPerson?.corporateBody) {
      raw.legalPerson.corporateBody.termination = "2020-01-15T00:00:00";
      for (const member of raw.legalPerson.corporateBody.statutoryBody ?? []) {
        member.current = false;
      }
      for (const entry of raw.legalPerson.corporateBody.statutoryBodyType ??
        []) {
        entry.current = false;
      }
    }
    const company = parseExtract(raw);
    const positions =
      company?.statutoryBodies[0]?.members.map((member) => member.position) ??
      [];
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.every((position) => position !== null)).toBe(true);
  });

  test("excludes terminated-roster rows whose temporal effectiveTo has elapsed", async () => {
    // ORSR roster rows carry their validity window in `effectiveTo`
    // independently of `functionTerminationDate`. A shareholder /
    // supervisory-board member whose row was superseded leaves
    // `functionTerminationDate` empty but populates `effectiveTo`.
    // Without checking it, the terminated fallback surfaces every
    // historical row as part of the final roster.
    const raw = await readFixture<OrsrRawExtractResponse>("extract-eset.json");
    if (raw.legalPerson?.corporateBody) {
      raw.legalPerson.corporateBody.termination = "2020-01-15T00:00:00";
      for (const member of raw.legalPerson.corporateBody.stakeholder ?? []) {
        member.current = false;
        member.functionTerminationDate = null;
        member.effectiveTo = "2018-06-01T00:00:00";
      }
    }
    const company = parseExtract(raw);
    // Every stakeholder row has a real effectiveTo → all excluded.
    expect(company?.stakeholders).toEqual([]);
  });

  test("excludes former officers/shareholders who left before dissolution", async () => {
    // A row with an explicit `functionTerminationDate` represents
    // someone who resigned / divested while the company was still
    // live. They must NOT appear in the final roster.
    const raw = await readFixture<OrsrRawExtractResponse>("extract-eset.json");
    if (raw.legalPerson?.corporateBody) {
      raw.legalPerson.corporateBody.termination = "2020-01-15T00:00:00";
      const body = raw.legalPerson.corporateBody;
      for (const [index, member] of (body.statutoryBody ?? []).entries()) {
        member.current = false;
        // Mark every OTHER statutory-body row as having departed
        // before the company terminated.
        if (index % 2 === 0) {
          member.functionTerminationDate = "2018-06-01T00:00:00";
        }
      }
      for (const member of body.stakeholder ?? []) {
        member.current = false;
        member.functionTerminationDate = "2018-06-01T00:00:00";
      }
    }
    const company = parseExtract(raw);
    // Half the statutory-body rows had explicit termination dates;
    // expect the roster to be roughly half size — but always at least
    // one row, since at least one fixture entry has no termination
    // date.
    expect(company?.statutoryBodies[0]?.members.length ?? 0).toBeGreaterThan(0);
    // Every stakeholder had a termination date → excluded.
    expect(company?.stakeholders).toEqual([]);
  });
});

describe("parseSearchHit", () => {
  test("composes a search hit from the registry's two address lines", () => {
    const hit: OrsrRawSearchHit = {
      id: 5994,
      registrationNumber: "31333532",
      corporateBodyFullName: "ESET, spol. s r.o.",
      physicalAddressLine1: "Einsteinova 24",
      physicalAddressLine2: "851 01 Bratislava",
    };
    expect(parseSearchHit(hit)).toEqual({
      ico: "31333532",
      name: "ESET, spol. s r.o.",
      address: "Einsteinova 24, 851 01 Bratislava",
    });
  });

  test("returns null address when both lines are empty", () => {
    const hit: OrsrRawSearchHit = {
      id: 1,
      registrationNumber: "12345678",
      corporateBodyFullName: "X",
      physicalAddressLine1: "",
      physicalAddressLine2: "",
    };
    expect(parseSearchHit(hit).address).toBeNull();
  });
});
