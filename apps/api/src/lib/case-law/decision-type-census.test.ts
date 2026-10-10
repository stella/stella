/**
 * Census of stored decision types against the canonical-kind table.
 *
 * `decision-type-inventory.json` lists, per jurisdiction, every decision type
 * the corpus index holds (regenerated from the engine) and every type an
 * adapter's closed vocabulary can state before it is first stored. The facet
 * and its filter read a stored type only through `readDecisionType`, so a
 * type the table does not name is a bucket that falls into `other` unexplained.
 * This suite holds the inventory and the table in step in both directions,
 * over every jurisdiction a registered source writes.
 *
 * Docket numbers stored as a type and joined lists (`nález,nález`) are read
 * safely, but they are an adapter's defect, not a mapping: they are reported
 * in their own buckets and pinned below, so a new one fails here until its
 * adapter is fixed or it is acknowledged. Each kind's label in every locale is
 * held by the web's own test over the same kind list.
 */

import { expect, test } from "bun:test";

import {
  DECISION_TYPE_KIND_OTHER,
  DECISION_TYPE_KINDS,
} from "@stll/api-contract/case-law-decision-types";

import inventory from "@/api/lib/case-law/decision-type-inventory.json" with { type: "json" };
import { decisionTypeKey } from "@/api/lib/case-law/decision-type-key";
import {
  readDecisionType,
  STATED_DECISION_TYPE_KINDS,
} from "@/api/lib/case-law/decision-type-kind";
import {
  ADAPTER_MANIFESTS,
  IMPORT_SOURCE_MANIFESTS,
} from "@/api/lib/legal-search/adapter-manifest";

type ValuesByJurisdiction = Readonly<Record<string, readonly string[]>>;

type CensusInput = {
  stored: ValuesByJurisdiction;
  adapterVocabulary: ValuesByJurisdiction;
  registered: readonly string[];
};

type CensusReport = {
  /** Values no table entry, docket rule or joined reading accounts for. */
  unmapped: string[];
  /** Defect: a docket number stored as the type (cz-nss before parser 16). */
  docketNumbers: string[];
  /** Defect: several forms joined into one value (sk-us `mkFormOfDecision`). */
  joined: string[];
  /** Table keys no jurisdiction stores and no adapter vocabulary names. */
  unaccounted: string[];
  /** Registered jurisdictions the inventory has no list for. */
  uncounted: string[];
  /** Lists that are not sorted and unique. */
  unsorted: string[];
};

const census = ({
  stored,
  adapterVocabulary,
  registered,
}: CensusInput): CensusReport => {
  const values = [
    ...new Set(
      [...Object.values(stored), ...Object.values(adapterVocabulary)].flat(),
    ),
  ].toSorted();
  const byReading = (type: string) =>
    values.filter((value) => readDecisionType(value).type === type);
  const keys = new Set(values.map((value) => decisionTypeKey(value)));
  return {
    unmapped: byReading("unmapped"),
    docketNumbers: byReading("docket"),
    joined: byReading("joined"),
    unaccounted: Object.keys(STATED_DECISION_TYPE_KINDS).filter(
      (key) => !keys.has(key),
    ),
    uncounted: registered.filter(
      (country) =>
        stored[country] === undefined &&
        adapterVocabulary[country] === undefined,
    ),
    unsorted: [
      ...Object.entries(stored),
      ...Object.entries(adapterVocabulary),
    ].flatMap(([country, list]) => {
      const canonical = [...new Set(list)].toSorted();
      return canonical.length === list.length &&
        canonical.every((value, index) => value === list[index])
        ? []
        : [country];
    }),
  };
};

/**
 * Defects production stores today, each owned by an adapter fix. The census
 * pins them, so the set can only shrink as replays clear them: a new docket or
 * joined value fails until it is fixed at its adapter or added here with one.
 */
const KNOWN_DEFECTS = {
  // cz-nss; parser 16 rejects a docket-shaped type, a replay clears these.
  docketNumbers: [
    "63 az 17/2026 - 28",
    "72 ad 59/2025 - 26",
    "8 a 17/2026 - 34",
    "8 af 24/2025 - 50",
  ],
  // sk-us stores the publisher's `mkFormOfDecision` list as one value.
  joined: [
    "nález,nález",
    "nález,nález,nález",
    "nález,nález,nález,nález,nález",
    "nález,nález,nález,nález,nález,nález,nález",
    "rozsudok,rozsudok",
    "uznesenie,nález",
    "uznesenie,uznesenie",
    "uznesenie,uznesenie,uznesenie",
    "uznesenie,uznesenie,uznesenie,uznesenie",
    "uznesenie,uznesenie,uznesenie,uznesenie,uznesenie",
    "uznesenie,uznesenie,uznesenie,uznesenie,uznesenie,uznesenie",
  ],
} as const;

const REGISTERED_JURISDICTIONS = [
  ...new Set(
    [
      ...Object.values(ADAPTER_MANIFESTS),
      ...Object.values(IMPORT_SOURCE_MANIFESTS),
    ].map(({ country }) => country),
  ),
];

const CENSUS_INPUT: CensusInput = {
  stored: inventory.jurisdictions,
  adapterVocabulary: inventory.adapterVocabulary,
  registered: REGISTERED_JURISDICTIONS,
};

test("every stored decision type has a canonical kind, for every registered jurisdiction", () => {
  expect(REGISTERED_JURISDICTIONS.length).toBeGreaterThan(0);
  expect(census(CENSUS_INPUT)).toEqual({
    unmapped: [],
    docketNumbers: [...KNOWN_DEFECTS.docketNumbers],
    joined: [...KNOWN_DEFECTS.joined],
    unaccounted: [],
    uncounted: [],
    unsorted: [],
  });
});

test("the census reports an unmapped type, a new defect, an orphan entry and an uncounted jurisdiction", () => {
  const unmapped = "zzz-nepojmenovaný-typ";
  const docket = "9 Azs 1/2027 - 12";
  const joined = "rozsudok,uznesenie";
  expect(readDecisionType(unmapped).type).toBe("unmapped");
  const { CZE, ...withoutCzech } = inventory.jurisdictions;
  const { CZE: _czechVocabulary, ...vocabularyWithoutCzech } =
    inventory.adapterVocabulary;
  const report = census({
    stored: {
      ...withoutCzech,
      SVK: [
        ...inventory.jurisdictions.SVK,
        docket,
        joined,
        unmapped,
      ].toSorted(),
    },
    adapterVocabulary: vocabularyWithoutCzech,
    registered: REGISTERED_JURISDICTIONS,
  });

  expect(report.unmapped).toEqual([unmapped]);
  expect(report.docketNumbers).toEqual([docket]);
  expect(report.joined).toContain(joined);
  // Czech-only spellings are now accounted for by nothing.
  expect(report.unaccounted).toContain("usn.");
  expect(report.uncounted).toEqual(["CZE"]);
  expect(CZE).toContain("usn.");
  expect(
    census({ ...CENSUS_INPUT, stored: { CZE: ["usnesení", "usn."] } }).unsorted,
  ).toEqual(["CZE"]);
});

test("every kind but the catch-all is stated by some table entry", () => {
  const stated = new Set<string>(Object.values(STATED_DECISION_TYPE_KINDS));
  expect(
    DECISION_TYPE_KINDS.filter(
      (kind) => kind !== DECISION_TYPE_KIND_OTHER && !stated.has(kind),
    ),
  ).toEqual([]);
});
