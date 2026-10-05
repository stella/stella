/**
 * Census of stored decision types against the canonical-kind table.
 *
 * `decision-type-inventory.json` lists, per jurisdiction, every decision type
 * the corpus stores. The type facet and its filter read a stored type only
 * through `STATED_DECISION_TYPE_KINDS`, so a stored type missing from it is a
 * facet bucket that falls into `other` and a spelling the index filter cannot
 * name. This suite holds the two in step in both directions, over every
 * jurisdiction a registered source writes, so a new adapter or a new spelling
 * in the inventory cannot land without its kind. Each kind's label in every
 * locale is held by the web's own test over the same kind list.
 */

import { expect, test } from "bun:test";

import {
  DECISION_TYPE_KIND_OTHER,
  DECISION_TYPE_KINDS,
} from "@stll/api-contract/case-law-decision-types";

import inventory from "@/api/lib/case-law/decision-type-inventory.json";
import {
  decisionTypeKey,
  STATED_DECISION_TYPE_KINDS,
} from "@/api/lib/case-law/decision-type-key";
import {
  ADAPTER_MANIFESTS,
  IMPORT_SOURCE_MANIFESTS,
} from "@/api/lib/legal-search/adapter-manifest";

type DecisionTypeInventory = Readonly<
  Record<string, readonly string[] | undefined>
>;

type CensusGaps = {
  /** Stored spellings the kind table does not name. */
  unmapped: string[];
  /** Spellings the kind table names that no jurisdiction stores. */
  unstored: string[];
  /** Jurisdictions a registered source writes that the inventory omits. */
  uncounted: string[];
  /** Jurisdiction lists that are not sorted, unique and in stored form. */
  malformed: string[];
};

const censusGaps = (
  jurisdictions: DecisionTypeInventory,
  registered: readonly string[],
): CensusGaps => {
  const stored = new Set(Object.values(jurisdictions).flatMap((v) => v ?? []));
  return {
    unmapped: [...stored].filter(
      (value) => !Object.hasOwn(STATED_DECISION_TYPE_KINDS, value),
    ),
    unstored: Object.keys(STATED_DECISION_TYPE_KINDS).filter(
      (value) => !stored.has(value),
    ),
    uncounted: registered.filter(
      (country) => jurisdictions[country] === undefined,
    ),
    malformed: Object.entries(jurisdictions).flatMap(([country, values]) => {
      const list = values ?? [];
      const canonical = [...new Set(list)].toSorted();
      const storedForm = list.every(
        (value) => decisionTypeKey(value) === value,
      );
      return storedForm &&
        canonical.length === list.length &&
        canonical.every((value, index) => value === list[index])
        ? []
        : [country];
    }),
  };
};

const NO_GAPS: CensusGaps = {
  unmapped: [],
  unstored: [],
  uncounted: [],
  malformed: [],
};

const REGISTERED_JURISDICTIONS = [
  ...new Set(
    [
      ...Object.values(ADAPTER_MANIFESTS),
      ...Object.values(IMPORT_SOURCE_MANIFESTS),
    ].map(({ country }) => country),
  ),
];

test("every stored decision type has a canonical kind, for every registered jurisdiction", () => {
  expect(REGISTERED_JURISDICTIONS.length).toBeGreaterThan(0);
  expect(censusGaps(inventory.jurisdictions, REGISTERED_JURISDICTIONS)).toEqual(
    NO_GAPS,
  );
});

test("the census fails on a stored type with no kind, an orphan spelling and an uncounted jurisdiction", () => {
  const unmapped = "zzz-nepojmenovaný-typ";
  expect(Object.hasOwn(STATED_DECISION_TYPE_KINDS, unmapped)).toBe(false);
  const { CZE, ...withoutCzech } = inventory.jurisdictions;
  const gaps = censusGaps(
    { ...withoutCzech, SVK: [...inventory.jurisdictions.SVK, unmapped] },
    REGISTERED_JURISDICTIONS,
  );

  expect({ ...gaps, unstored: gaps.unstored.toSorted() }).toEqual({
    unmapped: [unmapped],
    // Czech spellings no other jurisdiction stores are now orphans.
    unstored: CZE.filter(
      (value) =>
        !Object.values(withoutCzech).some((values) => values.includes(value)),
    ).toSorted(),
    uncounted: ["CZE"],
    malformed: [],
  });
  expect(censusGaps({ CZE: ["usnesení", "usn."] }, []).malformed).toEqual([
    "CZE",
  ]);
});

test("every kind but the catch-all is stated by some stored spelling", () => {
  const stated = new Set<string>(Object.values(STATED_DECISION_TYPE_KINDS));
  expect(
    DECISION_TYPE_KINDS.filter(
      (kind) => kind !== DECISION_TYPE_KIND_OTHER && !stated.has(kind),
    ),
  ).toEqual([]);
});
