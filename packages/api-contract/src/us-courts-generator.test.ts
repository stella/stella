import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  buildUsCourtDirectory,
  CODE_DISPOSITIONS,
  DIRECTORY_PATH,
  inputsFromFiles,
  readInputFiles,
  regionsNamedIn,
  renderDirectory,
} from "../../../scripts/generate-us-courts";
import type {
  SourceCourt,
  UsCourtInputs,
  UsCourtOverrides,
} from "../../../scripts/generate-us-courts";
import { US_COURT_DIRECTORY_SOURCES } from "./us-courts";

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

describe("the committed court directory", () => {
  test("is what its committed inputs generate, the same way every time", async () => {
    const files = await readInputFiles();
    const first = renderDirectory(
      buildUsCourtDirectory(inputsFromFiles(files)),
      files,
    );
    const second = renderDirectory(
      buildUsCourtDirectory(inputsFromFiles(files)),
      files,
    );
    expect(second).toBe(first);
    expect(await readFile(DIRECTORY_PATH, "utf-8")).toBe(first);
    expect(US_COURT_DIRECTORY_SOURCES).toMatchObject({
      courtListenerProjectionSha256: sha256(files.courtListener),
      courtsDbProjectionSha256: sha256(files.courtsDb),
      overridesSha256: sha256(files.overrides),
    });
  });

  test("marks the one region its evidence does not settle", async () => {
    const { overrides } = inputsFromFiles(await readInputFiles());
    expect(
      overrides.regions
        .filter(({ certainty }) => certainty === "reviewed-uncertain")
        .map(({ id, region }) => [id, region]),
    ).toEqual([["coregsalina", "CO"]]);
  });

  test("gives every source jurisdiction code a disposition", async () => {
    const { courts, overrides } = inputsFromFiles(await readInputFiles());
    const recoded = new Set(overrides.jurisdictionCodes.map(({ id }) => id));
    const codes = new Set(courts.map(({ jurisdiction }) => jurisdiction));
    // "" and "St" are not codes of the source's model; each row carrying one
    // has a reviewed code of its own.
    expect([...codes].filter((code) => !(code in CODE_DISPOSITIONS))).toEqual(
      expect.arrayContaining(["", "St"]),
    );
    const undisposed = courts.filter(
      ({ id, jurisdiction }) =>
        !(jurisdiction in CODE_DISPOSITIONS) && !recoded.has(id),
    );
    expect(undisposed).toEqual([]);
    expect(Object.keys(CODE_DISPOSITIONS).toSorted()).toEqual(
      [
        "C",
        "F",
        "FB",
        "FBP",
        "FD",
        "FS",
        "I",
        "MA",
        "S",
        "SA",
        "SAG",
        "SS",
        "ST",
        "T",
        "TA",
        "TRA",
        "TRS",
        "TRT",
        "TRX",
        "TS",
        "TT",
      ].toSorted(),
    );
  });
});

// Synthetic fixtures: minimal source rows exercising one rule each.
const source = (
  id: string,
  jurisdiction: string,
  fullName: string,
  parent = "",
): SourceCourt => ({
  id,
  jurisdiction,
  full_name: fullName,
  short_name: fullName,
  in_use: "t",
  start_date: "",
  end_date: "",
  parent_court_id: parent,
});

const NO_OVERRIDES: UsCourtOverrides = {
  jurisdictionCodes: [],
  systems: [],
  tiers: [],
  classifications: [],
  regions: [],
  canonicalNames: [],
};

const build = (
  courts: readonly SourceCourt[],
  overrides: Partial<UsCourtOverrides> = {},
  locations: Readonly<Record<string, string>> = {},
) => {
  const inputs: UsCourtInputs = {
    courts,
    courtsDbLocations: new Map(Object.entries(locations)),
    overrides: { ...NO_OVERRIDES, ...overrides },
  };
  return buildUsCourtDirectory(inputs);
};

describe("directory generation rules", () => {
  test("a region comes from courts-db, then from a same-system parent", () => {
    const entries = build(
      [
        source("ohio", "S", "Ohio Supreme Court"),
        source("ohchild", "ST", "Some County Court", "ohio"),
        source("ohd", "FD", "District Court, N.D. Ohio", "ohio"),
      ],
      {},
      { ohio: "Ohio", ohd: "Ohio" },
    );
    expect(
      entries.map((entry) =>
        entry.status === "accepted" ? [entry.id, entry.region] : [],
      ),
    ).toEqual([
      ["ohchild", "OH"],
      ["ohd", "OH"],
      ["ohio", "OH"],
    ]);
  });

  test("a state court left without a region fails generation", () => {
    expect(() => build([source("nowhere", "ST", "County Court")])).toThrow(
      "nowhere: no region for a state court",
    );
  });

  test("a national parent's reach is never inherited as a place", () => {
    expect(() =>
      build(
        [
          source("usparent", "F", "United States Circuit Court"),
          source("uschild", "F", "Circuit Court for Somewhere", "usparent"),
        ],
        {},
        { usparent: "United States" },
      ),
    ).toThrow("uschild: no region for a federal court");
  });

  test("an unknown jurisdiction code fails generation", () => {
    expect(() => build([source("odd", "X", "Odd Court")])).toThrow(
      'odd: jurisdiction code "X" has no disposition',
    );
  });

  test("a committee needs a reviewed system", () => {
    expect(() =>
      build([source("comm", "C", "Committee")], {}, { comm: "Ohio" }),
    ).toThrow("comm: code C names no system");
  });

  test("region evidence must name exactly the region it claims", () => {
    const court = source("wvct", "ST", "West Virginia County Court");
    expect(() =>
      build([court], {
        regions: [
          { id: "wvct", region: "VA", evidence: { fullName: "West Virginia" } },
        ],
      }),
    ).toThrow('"West Virginia" names WV, not VA, for wvct');
    expect(() =>
      build([court], {
        regions: [{ id: "wvct", region: "WV", evidence: { fullName: "Ohio" } }],
      }),
    ).toThrow('wvct full name does not contain "Ohio"');
    expect(
      build([court], {
        regions: [
          { id: "wvct", region: "WV", evidence: { fullName: "West Virginia" } },
        ],
      }),
    ).toMatchObject([{ id: "wvct", region: "WV" }]);
  });

  test("an override that changes nothing, or names no court, fails", () => {
    expect(() =>
      build(
        [source("ohio", "S", "Ohio Supreme Court")],
        {
          regions: [
            { id: "ohio", region: "OH", evidence: { fullName: "Ohio" } },
          ],
          tiers: [{ id: "ohio", tier: "supreme", reason: "restated" }],
        },
        { ohio: "Ohio" },
      ),
    ).toThrow(
      /tiers: ohio is already supreme[\s\S]*regions: ohio resolves to OH without its override/u,
    );
    expect(() =>
      build(
        [source("ohio", "S", "Ohio Supreme Court")],
        {
          tiers: [{ id: "gone", tier: "trial", reason: "no such court" }],
        },
        { ohio: "Ohio" },
      ),
    ).toThrow("tiers: gone is not a source court");
  });

  test("courts sharing a name fail until a reviewed name tells them apart", () => {
    const courts = [
      source("landa", "SS", "Land Court"),
      source("landb", "ST", "Land Court"),
    ];
    const locations = { landa: "Ohio", landb: "Ohio" };
    expect(() => build(courts, {}, locations)).toThrow(
      'landa, landb: share the canonical name "Land Court"',
    );
    expect(
      build(
        courts,
        {
          canonicalNames: [
            {
              id: "landb",
              canonicalName: "Land Court [CL:landb]",
              evidence: { note: "a second record of the same court" },
            },
          ],
        },
        locations,
      ).map((entry) =>
        entry.status === "accepted" ? entry.canonicalName : entry.id,
      ),
    ).toEqual(["Land Court", "Land Court [CL:landb]"]);
  });

  test("rejected codes stay in the directory with their reason", () => {
    expect(
      build([source("trial", "T", "Testing Court"), source("uk", "I", "UK")]),
    ).toEqual([
      {
        status: "rejected",
        id: "trial",
        sourceName: "Testing Court",
        rawJurisdiction: "T",
        reason: "testing",
      },
      {
        status: "rejected",
        id: "uk",
        sourceName: "UK",
        rawJurisdiction: "I",
        reason: "outside-jurisdiction",
      },
    ]);
  });

  test("a longer region name wins over a shorter one inside it", () => {
    expect(regionsNamedIn("West Virginia")).toEqual(["WV"]);
    expect(regionsNamedIn("Washington Territory")).toEqual([
      "washington-territory",
    ]);
    expect(regionsNamedIn("Supreme Court Of The Territory Of Dakota")).toEqual([
      "dakota-territory",
    ]);
    expect(regionsNamedIn("Kansas and Arkansas")).toEqual(["AR", "KS"]);
    expect(regionsNamedIn("Delaware County Court, Ohio")).toEqual(["DE", "OH"]);
  });
});
