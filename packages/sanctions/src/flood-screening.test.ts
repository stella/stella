import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { SanctionsEntry } from "./entry";
import { parseOfacList } from "./ofac";
import { buildScreeningIndex, DEFAULT_CUTOFF, screen } from "./screening";
import { largeOfacSdnXml } from "./test-fixtures/large-ofac-list";

const encoder = new TextEncoder();
async function* xmlBytes(xml: string) {
  yield encoder.encode(xml);
}

const fixtureEntry = async () => {
  const list = (
    await parseOfacList("us-sdn", xmlBytes(largeOfacSdnXml(1)))
  ).unwrap();
  return list.entries.at(0) ?? panic("large list fixture has no entry");
};

const version = {
  source: "us-sdn",
  publishedAt: "2026-09-23",
  fileId: null,
} as const;

type NamedEntryOptions = {
  base: SanctionsEntry;
  sourceId: string;
  name: string;
};
const namedEntry = ({
  base,
  sourceId,
  name,
}: NamedEntryOptions): SanctionsEntry => ({
  ...base,
  sourceId,
  entityType: "organisation",
  names: [{ name, quality: "strong" }],
});

const commonTokenEntries = (base: SanctionsEntry, stem: string) => {
  const letters = "abcdefghijklmnopqrst";
  return Array.from(letters).flatMap((first) =>
    Array.from(letters).map((second) =>
      namedEntry({
        base,
        sourceId: `${first}${second}`,
        name: `${stem}${first}${second} of Holdings`,
      }),
    ),
  );
};

test("preserves a distinctive match among common-token entries", async () => {
  const list = (
    await parseOfacList("us-sdn", xmlBytes(largeOfacSdnXml(20_000)))
  ).unwrap();
  for (const entry of list.entries) {
    entry.entityType = "organisation";
    entry.names = entry.names.map(({ name, quality }) => ({
      name: `${name} of Meridian`,
      quality,
    }));
  }
  const base = list.entries.at(0);
  if (base === undefined) {
    panic("large list fixture has no entry");
  }
  list.entries.push({
    ...base,
    sourceId: "distinctive",
    names: [{ name: "Quorinel of Meridian", quality: "strong" }],
  });
  const index = buildScreeningIndex([list]);
  for (const name of ["Quorinel of Meridian", "Quorinel of Meridan"]) {
    const result = screen(
      index,
      { name, entityType: "organisation" },
      { cutoff: DEFAULT_CUTOFF },
    );
    expect(
      result.unwrap().possibleMatches.map(({ entry }) => entry.sourceId),
    ).toContain("distinctive");
  }
}, 30_000);

test("keeps a one-edit match ahead of a flood of two-edit vocabulary candidates", async () => {
  const base = await fixtureEntry();
  const target = namedEntry({
    base,
    sourceId: "one-edit",
    name: "Quorienl of Meridian",
  });
  const query = {
    name: "Quorinel of Meridian",
    entityType: "organisation",
  } as const;
  const baseline = screen(
    buildScreeningIndex([{ version, entries: [target] }]),
    query,
    { cutoff: DEFAULT_CUTOFF },
  ).unwrap();
  expect(baseline.possibleMatches.map(({ entry }) => entry.sourceId)).toContain(
    "one-edit",
  );
  const common = commonTokenEntries(base, "Quorinel");
  for (const entries of [
    [...common, target],
    [target, ...common.toReversed()],
  ]) {
    const result = screen(buildScreeningIndex([{ version, entries }]), query, {
      cutoff: DEFAULT_CUTOFF,
    }).unwrap();
    expect(result.possibleMatches.map(({ entry }) => entry.sourceId)).toContain(
      "one-edit",
    );
  }
});

test("a large fuzzy vocabulary preserves a late strong match within the work bound", async () => {
  const base = await fixtureEntry();
  const stem = "quorinelabor";
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const spellings = new Set<string>();
  for (let left = 0; left < stem.length; left += 1) {
    for (let right = left + 1; right < stem.length; right += 1) {
      for (const first of alphabet) {
        for (const second of alphabet) {
          if (first === stem[left] || second === stem[right]) {
            continue;
          }
          const letters = Array.from(stem);
          letters[left] = first;
          letters[right] = second;
          spellings.add(letters.join(""));
          if (spellings.size === 20_000) {
            break;
          }
        }
        if (spellings.size === 20_000) {
          break;
        }
      }
      if (spellings.size === 20_000) {
        break;
      }
    }
    if (spellings.size === 20_000) {
      break;
    }
  }
  expect(spellings.size).toBe(20_000);
  const entries = Array.from(spellings, (spelling) =>
    namedEntry({
      base,
      sourceId: spelling,
      name: `${spelling} of Holdings`,
    }),
  );
  const target = namedEntry({
    base,
    sourceId: "late-strong",
    name: "quorinelabro of Meridian",
  });
  entries.push(target);
  const result = screen(
    buildScreeningIndex([{ version, entries }]),
    {
      name: `${stem} of Meridian`,
      entityType: "organisation",
    },
    { cutoff: DEFAULT_CUTOFF },
  ).unwrap();
  expect(result.possibleMatches.map(({ entry }) => entry.sourceId)).toContain(
    "late-strong",
  );
}, 30_000);

test("one substitution outranks two-edit spellings with the same character counts", async () => {
  const base = await fixtureEntry();
  const stem = "meridianovustalberg";
  const spellings = new Set<string>();
  for (let left = 0; left < stem.length; left += 1) {
    for (let right = left + 2; right < stem.length; right += 1) {
      const first = stem.at(left) ?? panic("missing first fixture letter");
      const second = stem.at(right) ?? panic("missing second fixture letter");
      if (first === second) {
        continue;
      }
      const letters = Array.from(stem);
      letters[left] = second;
      letters[right] = first;
      spellings.add(letters.join(""));
    }
  }
  expect(spellings.size).toBeGreaterThan(64);
  const entries = Array.from(spellings, (spelling) =>
    namedEntry({
      base,
      sourceId: spelling,
      name: `${spelling} of Holdings`,
    }),
  );
  const target = namedEntry({
    base,
    sourceId: "one-substitution",
    name: "meridianovustalberx of Norland",
  });
  entries.push(target);
  const result = screen(
    buildScreeningIndex([{ version, entries }]),
    {
      name: `${stem} of Norland`,
      entityType: "organisation",
    },
    { cutoff: DEFAULT_CUTOFF },
  ).unwrap();
  expect(result.possibleMatches.map(({ entry }) => entry.sourceId)).toContain(
    "one-substitution",
  );
});

test("adding unrelated common-token entries preserves a previously found match", async () => {
  const base = await fixtureEntry();
  assertProperty(
    "adding unrelated common-token entries preserves a previously found match",
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), {
          minLength: 5,
          maxLength: 9,
        })
        .map((letters) => `${letters.join("")}nel`),
      fc.constantFrom("Meridian", "Norland", "Selvaria"),
      fc.integer({ min: 65, max: 400 }),
      fc.boolean(),
      (stem, region, floodCount, targetFirst) => {
        const typo = `${stem.slice(0, -2)}${stem.at(-1)}${stem.at(-2)}`;
        const target = namedEntry({
          base,
          sourceId: "target",
          name: `${typo} of ${region}`,
        });
        const query = {
          name: `${stem} of ${region}`,
          entityType: "organisation",
        } as const;
        const baseline = screen(
          buildScreeningIndex([{ version, entries: [target] }]),
          query,
          { cutoff: DEFAULT_CUTOFF },
        ).unwrap();
        const expected = baseline.possibleMatches.map(
          ({ entry }) => entry.sourceId,
        );
        expect(expected).toContain("target");
        const common = commonTokenEntries(base, stem).slice(0, floodCount);
        const entries = targetFirst
          ? [target, ...common]
          : [...common.toReversed(), target];
        const extended = screen(
          buildScreeningIndex([{ version, entries }]),
          query,
          { cutoff: DEFAULT_CUTOFF },
        ).unwrap();
        const actual = extended.possibleMatches.map(
          ({ entry }) => entry.sourceId,
        );
        for (const sourceId of expected) {
          expect(actual).toContain(sourceId);
        }
      },
    ),
    { numRuns: 20 },
  );
}, 20_000);

test("single-edit matches survive common vocabulary across Unicode spellings", async () => {
  const base = await fixtureEntry();
  assertProperty(
    "single-edit matches survive common vocabulary across Unicode spellings",
    fc.property(
      fc.array(fc.constantFrom(..."abcdefghilmnoprstu"), {
        minLength: 5,
        maxLength: 9,
      }),
      fc.constantFrom("", "𐐀", "Ω"),
      fc.constantFrom("insertion", "deletion", "substitution", "transposition"),
      fc.boolean(),
      (letters, prefix, edit, targetFirst) => {
        const stem = `${prefix}${letters.join("")}nel`;
        let spelling: string;
        switch (edit) {
          case "insertion":
            spelling = `${stem}x`;
            break;
          case "deletion":
            spelling = stem.slice(0, -1);
            break;
          case "substitution":
            spelling = `${stem.slice(0, -1)}r`;
            break;
          case "transposition":
            spelling = `${stem.slice(0, -2)}le`;
            break;
          default: {
            const exhaustive: never = edit;
            return exhaustive;
          }
        }
        const target = namedEntry({
          base,
          sourceId: "single-edit",
          name: `${spelling} of Norland`,
        });
        const query = {
          name: `${stem} of Norland`,
          entityType: "organisation",
        } as const;
        const baseline = screen(
          buildScreeningIndex([{ version, entries: [target] }]),
          query,
          { cutoff: DEFAULT_CUTOFF },
        ).unwrap();
        expect(
          baseline.possibleMatches.map(({ entry }) => entry.sourceId),
        ).toContain("single-edit");
        const common = commonTokenEntries(base, stem);
        const entries = targetFirst ? [target, ...common] : [...common, target];
        const result = screen(
          buildScreeningIndex([{ version, entries }]),
          query,
          { cutoff: DEFAULT_CUTOFF },
        ).unwrap();
        expect(
          result.possibleMatches.map(({ entry }) => entry.sourceId),
        ).toContain("single-edit");
      },
    ),
    { numRuns: 24 },
  );
}, 20_000);
