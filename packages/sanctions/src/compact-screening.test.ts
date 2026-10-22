import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { ParsedList, SanctionsEntry } from "./entry";
import {
  buildScreeningIndex,
  buildScreeningIndexCooperatively,
  cloneScreeningIndexWithoutCache,
  screen,
} from "./screening";
import type { ScreeningQuery } from "./screening";
import { compactLists } from "./test-fixtures/compact-lists";
import {
  buildScreeningIndex as buildLegacyScreeningIndex,
  screen as legacyScreen,
} from "./test-fixtures/legacy-screening";

type SeededEntryOptions = {
  base: SanctionsEntry;
  sourceId: string;
  names: SanctionsEntry["names"];
};

const seededEntry = ({
  base,
  sourceId,
  names,
}: SeededEntryOptions): SanctionsEntry => ({
  ...base,
  sourceId,
  names,
  entityType: "person",
});

const equivalenceLists = (counts = [20_000, 420, 380]): ParsedList[] => {
  const lists = compactLists(counts);
  const ofac = lists.at(0);
  const base = ofac?.entries.at(0);
  if (ofac === undefined || base === undefined) {
    throw new Error("compact list fixture has no OFAC entry");
  }
  ofac.entries.push(
    seededEntry({
      base,
      sourceId: "transliterations",
      names: [
        { name: "Zerovan Velnakov", quality: "strong" },
        { name: "Velnakov, Zerovan", quality: "strong" },
        { name: "Зерован Велнаков", quality: "strong" },
        { name: "Zerowan Welnakow", quality: "weak" },
      ],
    }),
    seededEntry({
      base,
      sourceId: "joined-name",
      names: [
        { name: "Nelori VELNO-RAK", quality: "strong" },
        { name: "Talunor Velmoraki", quality: "strong" },
      ],
    }),
    seededEntry({
      base,
      sourceId: "duplicate-alias-quality",
      names: [
        { name: "Kelori Al-Velnar", quality: "weak" },
        { name: "Kelori Al-Velnar", quality: "strong" },
        { name: "Kelori Velnar", quality: "weak" },
      ],
    }),
  );
  return lists;
};

const successfulQueries = (lists: readonly ParsedList[]): ScreeningQuery[] => {
  const queries: ScreeningQuery[] = [];
  for (const list of lists) {
    for (const entry of list.entries.slice(0, 3)) {
      const primary = entry.names.at(0);
      const alias = entry.names.at(-1);
      if (primary === undefined || alias === undefined) {
        throw new Error("compact list fixture has a nameless entry");
      }
      queries.push(
        { name: primary.name, entityType: entry.entityType },
        { name: alias.name, entityType: entry.entityType },
      );
    }
  }
  queries.push(
    { name: "Zerovan Velnakov", entityType: "person" },
    { name: "Velnakov, Zerovan", entityType: "person" },
    { name: "Зерован Велнаков", entityType: "person" },
    { name: "Zerowan Welnakow", entityType: "person" },
    { name: "Nelori Velnorak", entityType: "person" },
    { name: "Talunor Vel Moraki", entityType: "person" },
    { name: "Kelori Al-Velnar", entityType: "person" },
    { name: "Kelori Velnar", entityType: "person" },
    { name: "unlisted unfamiliar name", entityType: "person" },
    { name: "Zerovn Velnakov", entityType: "person" },
  );
  return queries;
};

type LegacyEquivalenceOptions = {
  index: ReturnType<typeof buildScreeningIndex>;
  expected: readonly LegacyScreenOutcome[];
  queries: readonly ScreeningQuery[];
};

const legacyScreenOutcome = (result: ReturnType<typeof legacyScreen>) =>
  result.isErr() ? { error: result.error } : { value: result.value };

type LegacyScreenOutcome = ReturnType<typeof legacyScreenOutcome>;

const assertLegacyEquivalence = ({
  index,
  expected,
  queries,
}: LegacyEquivalenceOptions) => {
  for (const [queryIndex, query] of queries.entries()) {
    const options = { cutoff: 0.65, limit: 25 };
    const legacyResult =
      expected.at(queryIndex) ?? panic("Missing legacy screening result");
    const actual = screen(index, query, options);
    expect(legacyScreenOutcome(actual)).toEqual(legacyResult);
  }
};

type AliasHitOptions = {
  index: ReturnType<typeof buildScreeningIndex>;
  name: string;
  expectedName: string;
  sourceId?: string;
};

const expectAliasHit = ({
  index,
  name,
  expectedName,
  sourceId = "transliterations",
}: AliasHitOptions) => {
  const matches = screen(
    index,
    { name, entityType: "person" },
    { cutoff: 0.65 },
  ).unwrap().possibleMatches;
  expect(matches.map(({ entry }) => entry.sourceId)).toContain(sourceId);
  expect(
    matches.find(({ entry }) => entry.sourceId === sourceId)?.evidence
      .matchedName,
  ).toBe(expectedName);
};

test("compact and cooperative screening preserve legacy results and full entries", async () => {
  const lists = equivalenceLists();
  const queries = successfulQueries(lists);
  const expected = (() => {
    const legacy = buildLegacyScreeningIndex(lists);
    return queries.map((query) =>
      legacyScreenOutcome(
        legacyScreen(legacy, query, { cutoff: 0.65, limit: 25 }),
      ),
    );
  })();
  Bun.gc(true);
  {
    const current = buildScreeningIndex(lists);
    let entryIndex = 0;
    for (const list of lists) {
      for (const entry of list.entries) {
        expect(current.entryStorage.hydrate(entryIndex)).toEqual(entry);
        entryIndex += 1;
      }
    }
    expect(current.entries.length).toBe(entryIndex);
    assertLegacyEquivalence({ index: current, expected, queries });
    expectAliasHit({
      index: current,
      name: "Zerovan Velnakov",
      expectedName: "Zerovan Velnakov",
    });
    expectAliasHit({
      index: current,
      name: "Zerowan Welnakow",
      expectedName: "Zerovan Velnakov",
    });
    expectAliasHit({
      index: current,
      name: "Nelori Velnorak",
      expectedName: "Nelori VELNO-RAK",
      sourceId: "joined-name",
    });
    expectAliasHit({
      index: current,
      name: "Kelori Al-Velnar",
      expectedName: "Kelori Al-Velnar",
      sourceId: "duplicate-alias-quality",
    });
  }
  Bun.gc(true);
  const cooperative = await buildScreeningIndexCooperatively(
    lists,
    async () => {},
  );
  expect(cooperative.entries.length).toBe(
    lists.reduce((count, list) => count + list.entries.length, 0),
  );
  assertLegacyEquivalence({ index: cooperative, expected, queries });
}, 120_000);

test("compact screening preserves legacy work-limit and query errors", () => {
  Bun.gc(true);
  const lists = equivalenceLists([20, 10, 10]);
  const current = buildScreeningIndex(lists);
  const legacy = buildLegacyScreeningIndex(lists);
  const cases = [
    {
      query: { name: "Zerovan Velnakov", entityType: "person" },
      options: { cutoff: 0.65, maxWork: 1 },
    },
    {
      query: { name: "Zerovan Velnakov", birthDate: { year: 999 } },
      options: { cutoff: 0.65 },
    },
    { query: { name: " — " }, options: { cutoff: 0.65 } },
  ] as const satisfies readonly {
    query: ScreeningQuery;
    options: { cutoff: number; maxWork?: number };
  }[];

  for (const { query, options } of cases) {
    const expected = legacyScreen(legacy, query, options);
    const actual = screen(current, query, options);
    expect(actual.isErr() ? actual.error : actual.value).toEqual(
      expected.isErr() ? expected.error : expected.value,
    );
  }
});

test("cached absent spellings replay uncached results at every work-budget boundary", () => {
  const lists = equivalenceLists([20, 10, 10]);
  const compact = buildScreeningIndex(lists);
  const legacy = buildLegacyScreeningIndex(lists);
  const query = { name: "Kelori Velnr", entityType: "person" } as const;
  expect(compact.names.raw.ids.get("velnr")).toBeUndefined();
  const complete = screen(compact, query, { cutoff: 0.65 }).unwrap();
  expect(complete).toEqual(
    legacyScreen(legacy, query, { cutoff: 0.65 }).unwrap(),
  );
  // Fuzzy selection spends less work than the legacy scan, so fresh compact
  // indexes place the boundary. Binary search keeps that oracle inexpensive.
  const highestBudget = 3000;
  let lowestFailure = 1;
  let lowestSuccess = highestBudget;
  expect(
    screen(cloneScreeningIndexWithoutCache(compact), query, {
      cutoff: 0.65,
      maxWork: lowestFailure,
    }).isErr(),
  ).toBe(true);
  expect(
    screen(cloneScreeningIndexWithoutCache(compact), query, {
      cutoff: 0.65,
      maxWork: lowestSuccess,
    }).isOk(),
  ).toBe(true);
  while (lowestFailure + 1 < lowestSuccess) {
    const maxWork = Math.floor((lowestFailure + lowestSuccess) / 2);
    const outcome = screen(cloneScreeningIndexWithoutCache(compact), query, {
      cutoff: 0.65,
      maxWork,
    });
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("work-limit");
      lowestFailure = maxWork;
    } else {
      expect(outcome.value).toEqual(complete);
      lowestSuccess = maxWork;
    }
  }

  const budgets = [
    1,
    Math.floor(lowestSuccess / 3),
    Math.floor((lowestSuccess * 2) / 3),
    lowestSuccess - 1,
    lowestSuccess,
    lowestSuccess + 1,
    lowestSuccess + Math.floor((highestBudget - lowestSuccess) / 3),
    lowestSuccess + Math.floor(((highestBudget - lowestSuccess) * 2) / 3),
    highestBudget,
  ]
    .filter((maxWork) => maxWork >= 1 && maxWork <= highestBudget)
    .filter((maxWork, index, values) => values.indexOf(maxWork) === index)
    .toSorted((left, right) => left - right);
  const outcomes: ("failure" | "success")[] = [];
  for (const maxWork of budgets) {
    const options = { cutoff: 0.65, maxWork };
    const expected = screen(
      cloneScreeningIndexWithoutCache(compact),
      query,
      options,
    );
    const actual = screen(compact, query, options);
    expect(legacyScreenOutcome(actual)).toEqual(legacyScreenOutcome(expected));
    if (expected.isErr()) {
      expect(expected.error.code).toBe("work-limit");
      outcomes.push("failure");
    } else {
      expect(expected.value).toEqual(complete);
      outcomes.push("success");
    }
  }
  expect(outcomes.at(0)).toBe("failure");
  expect(outcomes.at(-1)).toBe("success");
  expect(
    outcomes.filter((outcome, index) => outcome !== outcomes.at(index - 1)),
  ).toEqual(["failure", "success"]);
});

test("identifier-only screening preserves shared postings and legacy work limits", () => {
  const lists = compactLists([2, 0, 0]);
  const list = lists.at(0);
  const first = list?.entries.at(0);
  const second = list?.entries.at(1);
  if (list === undefined || first === undefined || second === undefined) {
    throw new Error("identifier fixture needs two entries");
  }
  const identifier = first.identifiers.at(0);
  if (identifier === undefined) {
    throw new Error("identifier fixture needs a passport");
  }
  first.identifiers = [
    { ...identifier, number: "SX-314 159" },
    { ...identifier, number: "sx314159" },
    { ...identifier, number: "SX 314-159" },
  ];
  second.identifiers = [{ ...identifier, number: "SX314159" }];
  const current = buildScreeningIndex(lists);
  const legacy = buildLegacyScreeningIndex(lists);
  const queries = [
    { name: "", identifiers: ["sx 314-159"] },
    { name: "", identifiers: ["SX314159", "SX-314 159"] },
  ] as const satisfies readonly ScreeningQuery[];
  for (const query of queries) {
    const expected = legacyScreen(legacy, query, { cutoff: 0.8 }).unwrap();
    expect(expected.possibleMatches.map(({ entry }) => entry.sourceId)).toEqual(
      [first.sourceId, second.sourceId],
    );
    expect(
      expected.possibleMatches.every(
        ({ evidence }) =>
          evidence.identifier === "match" &&
          evidence.matchedName === null &&
          evidence.nameScore === 0,
      ),
    ).toBe(true);
    expect(screen(current, query, { cutoff: 0.8 }).unwrap()).toEqual(expected);
    let failures = 0;
    let successes = 0;
    // Sweep both sides of the success threshold: duplicate postings preserve
    // result values after Set deduplication but incorrectly consume more work.
    for (let maxWork = 1; maxWork <= 64; maxWork += 1) {
      const options = { cutoff: 0.8, maxWork };
      const expectedBudget = legacyScreen(legacy, query, options);
      const actualBudget = screen(current, query, options);
      expect(actualBudget.isErr()).toBe(expectedBudget.isErr());
      expect(
        actualBudget.isErr() ? actualBudget.error : actualBudget.value,
      ).toEqual(
        expectedBudget.isErr() ? expectedBudget.error : expectedBudget.value,
      );
      if (expectedBudget.isErr()) {
        expect(expectedBudget.error.code).toBe("work-limit");
        failures += 1;
      } else {
        successes += 1;
      }
    }
    expect(failures).toBeGreaterThan(0);
    expect(successes).toBeGreaterThan(0);
  }
});

// Few syllables give a dense vocabulary: long gram posting lists and many
// fuzzy neighbours per token. Non-Latin and astral letters reach the packed
// bigram keys' full code-point range and split folded from raw spellings.
const syllable = fc.constantFrom(
  "ka",
  "ri",
  "mo",
  "med",
  "al",
  "sch",
  "ov",
  "ša",
  "жи",
  "é",
  "𐐀",
  "ul",
);
const generatedWord = fc
  .array(syllable, { minLength: 2, maxLength: 4 })
  .map((parts) => parts.join(""));
const NAME_EDITS = [
  "exact",
  "transpose",
  "delete",
  "insert",
  "drop-token",
  "reverse",
] as const;
type NameEdit = (typeof NAME_EDITS)[number];

const editName = (name: string, edit: NameEdit): string => {
  const characters = Array.from(name);
  const tokens = name.split(" ");
  switch (edit) {
    case "exact":
      return name;
    case "transpose":
      return [
        ...characters.slice(0, -2),
        ...characters.slice(-2).toReversed(),
      ].join("");
    case "delete":
      return characters.slice(0, -1).join("");
    case "insert":
      return `${characters.slice(0, 2).join("")}a${characters.slice(2).join("")}`;
    case "drop-token":
      return tokens.length > 1 ? tokens.slice(1).join(" ") : name;
    case "reverse":
      return tokens.toReversed().join(" ");
    default:
      edit satisfies never;
      return panic("Unhandled generated name edit");
  }
};

test("compact screening matches the legacy oracle on generated dense lists", () => {
  const fixture =
    compactLists([1, 0, 0]).at(0) ?? panic("compact list fixture is empty");
  const base =
    fixture.entries.at(0) ?? panic("compact list fixture has no OFAC entry");
  assertProperty(
    "compact screening matches the legacy oracle on generated dense lists",
    fc.property(
      fc.uniqueArray(generatedWord, { minLength: 8, maxLength: 40 }),
      fc.array(
        fc.record({
          names: fc.array(fc.array(fc.nat(), { minLength: 1, maxLength: 3 }), {
            minLength: 1,
            maxLength: 3,
          }),
          entityType: fc.constantFrom("person", "organisation", "unknown"),
        }),
        { minLength: 1, maxLength: 60 },
      ),
      fc.array(
        fc.record({
          entry: fc.nat(),
          name: fc.nat(),
          edit: fc.constantFrom(...NAME_EDITS),
          entityType: fc.constantFrom(undefined, "person", "organisation"),
          cutoff: fc.constantFrom(0.5, 0.65, 0.8),
        }),
        { minLength: 1, maxLength: 8 },
      ),
      (words, shapes, probes) => {
        const entries = shapes.map(
          ({ names, entityType }, index): SanctionsEntry => ({
            ...base,
            sourceId: `generated-${index}`,
            entityType,
            names: names.map((tokens, alias) => ({
              name: tokens
                .map(
                  (token) =>
                    words[token % words.length] ??
                    panic("Missing generated word"),
                )
                .join(" "),
              quality: alias === 1 ? "weak" : "strong",
            })),
          }),
        );
        const lists: ParsedList[] = [{ version: fixture.version, entries }];
        const current = buildScreeningIndex(lists);
        const legacy = buildLegacyScreeningIndex(lists);
        for (const probe of probes) {
          const entry =
            entries[probe.entry % entries.length] ??
            panic("Missing generated entry");
          const listed =
            entry.names[probe.name % entry.names.length] ??
            panic("Missing generated name");
          const name = editName(listed.name, probe.edit);
          const query: ScreeningQuery =
            probe.entityType === undefined
              ? { name }
              : { name, entityType: probe.entityType };
          const options = { cutoff: probe.cutoff, limit: 25 };
          expect(legacyScreenOutcome(screen(current, query, options))).toEqual(
            legacyScreenOutcome(legacyScreen(legacy, query, options)),
          );
        }
      },
    ),
    { numRuns: 60 },
  );
}, 120_000);
