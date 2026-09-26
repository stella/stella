import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  resolveUsCourt,
  resolveWritableUsCourt,
  US_COURT_BY_CANONICAL_NAME,
  US_COURT_DIRECTORY,
  US_COURT_IDS,
  US_COURT_NAMES,
  US_COURT_PARTITION_COUNT,
  US_COURT_PARTITION_KEY_PREFIX,
  US_COURT_PARTITIONS,
  US_COURTS,
  US_HISTORICAL_TERRITORY_REGIONS,
  US_REJECTED_COURT_IDS,
  US_SCOPE_REGIONS,
  US_STATE_REGIONS,
  US_TERRITORY_REGIONS,
  US_WRITABLE_COURT_IDS,
} from "./us-courts";
import type { UsCourt, UsCourtSystem } from "./us-courts";

const court = (id: string): UsCourt | undefined =>
  US_COURTS.find((candidate) => candidate.id === id);

describe("the United States court directory", () => {
  test("every source court is exactly one entry, and only five are rejected", () => {
    expect(US_COURT_DIRECTORY).toHaveLength(3361);
    expect(US_COURTS).toHaveLength(3356);
    const ids = US_COURT_DIRECTORY.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(ids.toSorted());
    expect(
      US_COURT_DIRECTORY.flatMap((entry) =>
        entry.status === "rejected" ? [[entry.id, entry.reason]] : [],
      ),
    ).toEqual([
      ["highctjchuk", "outside-jurisdiction"],
      ["houseoflordsuk", "outside-jurisdiction"],
      ["kingsbench", "outside-jurisdiction"],
      ["psc", "testing"],
      ["test", "testing"],
    ]);
    expect(US_COURT_IDS).toEqual(US_COURTS.map(({ id }) => id));
    expect(US_REJECTED_COURT_IDS).toEqual([
      "highctjchuk",
      "houseoflordsuk",
      "kingsbench",
      "psc",
      "test",
    ]);
  });

  test("an accepted court resolves to its entry, by its exact id only", () => {
    expect(resolveUsCourt("scotus")).toEqual({
      type: "accepted",
      court: {
        status: "accepted",
        id: "scotus",
        sourceName: "Supreme Court of the United States",
        canonicalName: "Supreme Court of the United States",
        rawJurisdiction: "F",
        classification: "court",
        system: "federal",
        region: "national",
        tier: "supreme",
        startDate: "1789-09-24",
        endDate: null,
        sourceInUse: true,
        parentId: null,
        courtPartition: "p08",
      },
    });
    expect(resolveUsCourt("ca9")).toMatchObject({
      type: "accepted",
      court: { id: "ca9", tier: "appellate", region: "multistate" },
    });
    for (const courtId of [
      "SCOTUS",
      " scotus",
      "scotus ",
      "Supreme Court of the United States",
      "CA9",
      "",
    ]) {
      expect(resolveUsCourt(courtId)).toEqual({
        type: "rejected",
        courtId,
        reason: "unknown",
      });
    }
    expect(resolveUsCourt("psc")).toEqual({
      type: "rejected",
      courtId: "psc",
      reason: "testing",
    });
    expect(resolveUsCourt("kingsbench")).toEqual({
      type: "rejected",
      courtId: "kingsbench",
      reason: "outside-jurisdiction",
    });
  });

  test("acceptance is not write enrollment: only scotus is writable", () => {
    expect([...US_WRITABLE_COURT_IDS]).toEqual(["scotus"]);
    expect(resolveWritableUsCourt("scotus")).toMatchObject({
      type: "writable",
      court: { id: "scotus" },
    });
    expect(resolveWritableUsCourt("ca9")).toEqual({
      type: "rejected",
      courtId: "ca9",
      reason: "not-writable",
    });
    expect(resolveWritableUsCourt("test")).toEqual({
      type: "rejected",
      courtId: "test",
      reason: "testing",
    });
    expect(resolveWritableUsCourt("Scotus")).toEqual({
      type: "rejected",
      courtId: "Scotus",
      reason: "unknown",
    });
  });

  test("canonical names are unique regardless of case, trimmed and bounded", () => {
    expect(US_COURT_NAMES).toEqual(
      US_COURTS.map(({ canonicalName }) => canonicalName),
    );
    const folded = US_COURT_NAMES.map((name) => name.toLowerCase());
    expect(new Set(folded).size).toBe(US_COURT_NAMES.length);
    for (const name of US_COURT_NAMES) {
      expect([name, name.normalize("NFC").trim()]).toEqual([name, name]);
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(512);
    }
    expect(US_COURT_BY_CANONICAL_NAME.size).toBe(US_COURTS.length);
    expect(
      US_COURT_BY_CANONICAL_NAME.get("Supreme Court of the United States")?.id,
    ).toBe("scotus");
  });

  test("courts sharing a source name keep it and carry reviewed names", () => {
    expect(
      ["masslandct", "massland", "texctyct70", "texctyct71", "texctyct72"].map(
        (id) => {
          const entry = court(id);
          return [id, entry?.sourceName, entry?.canonicalName];
        },
      ),
    ).toEqual([
      ["masslandct", "Massachusetts Land Court", "Massachusetts Land Court"],
      [
        "massland",
        "Massachusetts Land Court",
        "Massachusetts Land Court [CL:massland]",
      ],
      [
        "texctyct70",
        "Texas City Court, Harris City Criminal Court at Law No.",
        "Texas City Court, Harris City Criminal Court at Law No. 3",
      ],
      [
        "texctyct71",
        "Texas City Court, Harris City Criminal Court at Law No.",
        "Texas City Court, Harris City Criminal Court at Law No. 4",
      ],
      [
        "texctyct72",
        "Texas City Court, Harris City Criminal Court at Law No.",
        "Texas City Court, Harris City Criminal Court at Law No. 11",
      ],
    ]);
    // Source spelling is kept apart from the trimmed canonical name.
    expect(court("usberlinct")).toMatchObject({
      sourceName: " United States Court of Berlin",
      canonicalName: "United States Court of Berlin",
    });
  });

  test("the two source anomalies resolve through reviewed overrides", () => {
    expect(court("ohctapp1")).toMatchObject({
      rawJurisdiction: "",
      system: "state",
      region: "OH",
      tier: "appellate",
    });
    expect(court("njcirctsussex")).toMatchObject({
      rawJurisdiction: "St",
      system: "state",
      region: "NJ",
      tier: "trial",
    });
  });

  test("tiers follow the directory, not the word 'Supreme' in a name", () => {
    const tierOf = (id: string) => court(id)?.tier;
    expect(tierOf("scotus")).toBe("supreme");
    expect(tierOf("nysupct")).toBe("trial");
    expect(tierOf("superctguam")).toBe("trial");
    expect(tierOf("ca9")).toBe("appellate");
    expect(tierOf("cand")).toBe("trial");
    expect(tierOf("tax")).toBe("special");
    // Committees and attorney-general reports are accepted and classified.
    expect(
      ["usjc", "fcc", "caljp", "ohiobar", "ohiocivright"].map((id) => [
        id,
        court(id)?.system,
        court(id)?.region,
        court(id)?.classification,
        court(id)?.tier,
      ]),
    ).toEqual([
      ["usjc", "federal", "national", "tribunal", "special"],
      ["fcc", "federal", "national", "tribunal", "special"],
      ["caljp", "state", "CA", "tribunal", "special"],
      ["ohiobar", "state", "OH", "tribunal", "special"],
      ["ohiocivright", "state", "OH", "tribunal", "special"],
    ]);
    expect(court("calag")?.classification).toBe("attorney-general");
  });

  test("every accepted court has a region its system allows", () => {
    const states = new Set<string>(Object.keys(US_STATE_REGIONS));
    const territories = new Set<string>([
      ...Object.keys(US_TERRITORY_REGIONS),
      ...Object.keys(US_HISTORICAL_TERRITORY_REGIONS),
    ]);
    const places = new Set<string>([...states, ...territories]);
    const scopes = new Set<string>(US_SCOPE_REGIONS);
    const allowed: Record<UsCourtSystem, (region: string) => boolean> = {
      state: (region) => states.has(region),
      tribal: (region) => states.has(region),
      territory: (region) => territories.has(region),
      federal: (region) => places.has(region) || scopes.has(region),
      military: (region) => places.has(region) || scopes.has(region),
    };
    const outside = US_COURTS.filter(
      ({ system, region }) => !allowed[system](region),
    ).map(({ id, system, region }) => [id, system, region]);
    // The one reviewed exception: the Privy Council's committee heard appeals
    // from several colonies.
    expect(outside).toEqual([["privycoun", "state", "multistate"]]);
    expect(court("dakotasup")).toMatchObject({
      system: "territory",
      region: "dakota-territory",
    });
    expect(court("canalzoned")).toMatchObject({
      system: "federal",
      region: "canal-zone",
    });
  });

  test("the court partition is SHA-256 of the prefixed id, first byte mod 16", () => {
    expect(US_COURT_PARTITION_KEY_PREFIX).toBe("USA:");
    expect(US_COURT_PARTITION_COUNT).toBe(16);
    expect(US_COURT_PARTITIONS).toHaveLength(US_COURT_PARTITION_COUNT);
    // Pinned values: a change to the prefix, the count, the hash or the
    // label format moves these, and with them nearly every court.
    expect(
      [
        "scotus",
        "ca9",
        "nyappdiv",
        "masslandct",
        "washterr",
        "superctguam",
        "usberlinct",
      ].map((id) => [id, court(id)?.courtPartition]),
    ).toEqual([
      ["scotus", "p08"],
      ["ca9", "p05"],
      ["nyappdiv", "p00"],
      ["masslandct", "p00"],
      ["washterr", "p09"],
      ["superctguam", "p11"],
      ["usberlinct", "p06"],
    ]);
    const derived = (id: string): string => {
      const digest = createHash("sha256")
        .update(`${US_COURT_PARTITION_KEY_PREFIX}${id}`, "utf-8")
        .digest();
      return `p${String((digest[0] ?? 0) % US_COURT_PARTITION_COUNT).padStart(2, "0")}`;
    };
    expect(
      US_COURTS.filter(
        ({ id, courtPartition }) => derived(id) !== courtPartition,
      ),
    ).toEqual([]);
  });
});
