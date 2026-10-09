import { expect, test } from "bun:test";

import type { EntityType, SanctionsEntry } from "./entry";
import { buildNameIndex, matchNames } from "./name-match";
import type { ScreeningWorkBudget } from "./name-match";
import { nameReading } from "./normalise";
import type { ScreeningIndex, ScreeningQuery } from "./screening";
import { buildScreeningIndex, DEFAULT_CUTOFF, screen } from "./screening";

const version = {
  source: "eu",
  publishedAt: "2026-09-22",
  fileId: null,
} as const;

const entry = (name: string, entityType: EntityType): SanctionsEntry => ({
  source: "eu",
  issuer: "EU",
  sourceId: name,
  referenceNumber: null,
  entityType,
  names: [{ name, quality: "strong" }],
  birthDates: [],
  nationalities: [],
  identifiers: [],
  addresses: [],
  programme: null,
  legalBasis: null,
  listedOn: null,
  sourceUrl: "https://lists.example/eu",
});

test("dense common names screen normally within the warm work bound", () => {
  let seed = 42;
  const random = () => {
    seed =
      (((Math.imul(seed, 1_103_515_245) + 12_345) % 2_147_483_648) +
        2_147_483_648) %
      2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = (values: readonly string[]) =>
    values[Math.floor(random() * values.length)] ?? "";
  const given = [
    "Mohammed",
    "Muhammad",
    "Mohamed",
    "Mohammad",
    "Ahmed",
    "Ali",
    "Hassan",
    "Hussein",
    "Abdul",
    "Omar",
    "Ibrahim",
    "Yusuf",
    "Khalid",
    "Sergey",
    "Alexander",
    "Vladimir",
    "Dmitry",
    "Andrei",
    "Igor",
    "Oleg",
    "Nikolai",
    "Ivan",
    "Yuri",
    "Kim",
    "Jong",
    "Hossein",
    "Reza",
    "Mahmoud",
    "Abdullah",
    "Saeed",
  ];
  const surnames = Array.from(
    { length: 3000 },
    (_, index) => `Sur${index.toString(36)}ov`,
  );
  const commonSurnames = [
    "Ivanov",
    "Petrov",
    "Al Hashimi",
    "Al Masri",
    "Hassan",
    "Ali",
    "Khan",
    "Rahman",
    "Kuznetsov",
    "Smirnov",
  ];
  const words = Array.from(
    { length: 4000 },
    (_, index) => `W${index.toString(36)}ex`,
  );
  const commonWords = [
    "Trading",
    "General Trading",
    "International",
    "Global",
    "Petroleum",
    "Shipping",
    "Industries",
    "Group",
    "Investment",
    "Bank",
    "Energy",
    "Holding",
  ];
  const forms = ["LLC", "Limited", "Company", "JSC", "FZE", "Co Ltd"];
  const entries = Array.from({ length: 20_000 }, (_, index) => {
    const entityType = random() < 0.55 ? "person" : "organisation";
    const names = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
      const name =
        entityType === "person"
          ? `${pick(given)} ${random() < 0.5 ? `${pick(given)} ` : ""}${random() < 0.25 ? pick(commonSurnames) : pick(surnames)}`
          : `${pick(words)} ${random() < 0.35 ? `${pick(commonWords)} ` : ""}${random() < 0.3 ? `${pick(words)} ` : ""}${pick(forms)}`;
      return { name, quality: "strong" } as const;
    });
    return { ...entry(String(index), entityType), names };
  });
  const index = buildScreeningIndex([{ version, entries }]);
  const timings = [];
  for (const [name, entityType] of [
    ["Mohammed Ali", "person"],
    ["Mohamed Hassan", "person"],
    ["Abdul Rahman", "person"],
    ["Sergey Ivanov", "person"],
    ["General Trading LLC", "organisation"],
    ["International Petroleum Shipping", "organisation"],
    ["Bank", "organisation"],
    ["Global Trading Company Limited", "organisation"],
  ] as const) {
    // Warm the JIT separately; index construction is outside the query budget.
    screen(index, { name, entityType }, { cutoff: DEFAULT_CUTOFF });
    for (const kind of [entityType, undefined]) {
      const started = performance.now();
      const result = screen(
        index,
        kind === undefined ? { name } : { name, entityType: kind },
        { cutoff: DEFAULT_CUTOFF },
      );
      const milliseconds = performance.now() - started;
      timings.push({
        name,
        entityType: kind ?? "unknown",
        milliseconds: Number(milliseconds.toFixed(2)),
        result: result.isErr() ? result.error.code : "ok",
      });
      expect(result.isOk()).toBe(true);
      if (result.isOk() && result.value.possibleMatches.length === 0) {
        expect(result.value.truncated).toBe(false);
      }
    }
  }
  console.info(JSON.stringify({ denseNames: timings }));
});

test("repeated rejected name patterns stay within a linear screening work budget", () => {
  for (const count of [100, 1000, 10_000]) {
    const index = buildNameIndex(
      Array.from({ length: count }, () =>
        entry("Registered Enterprise Holdings", "organisation"),
      ),
    );
    const reading = nameReading("Registered", "organisation");
    const exhaustive = matchNames({
      index,
      reading,
      ceiling: Math.sqrt,
      rankEntry: (_entry, score) => score,
      cutoff: 0,
      work: { remaining: 100 * count, exhausted: false, selection: "complete" },
    });
    expect(exhaustive?.matches.size).toBe(count);
    for (const match of exhaustive?.matches.values() ?? []) {
      expect(match.score).toBeGreaterThan(0);
      expect(match.score).toBeLessThan(DEFAULT_CUTOFF);
    }
    const work = {
      remaining: 8 * count,
      exhausted: false,
      selection: "complete",
    } satisfies ScreeningWorkBudget;
    const filtered = matchNames({
      index,
      reading,
      ceiling: Math.sqrt,
      rankEntry: (_entry, score) => score,
      cutoff: DEFAULT_CUTOFF,
      work,
    });
    expect(work.exhausted).toBe(false);
    expect(filtered?.matches.size).toBe(0);
    expect(filtered?.truncated).toBe(false);
  }
});

test("late exact and near-exact names survive thousands of same-token candidates", () => {
  const entries = Array.from({ length: 8000 }, (_, index) => ({
    ...entry(`Mohammed Middle${index} Ali`, "person"),
    sourceId: String(index),
  }));
  const exact = { ...entry("Mohammed Ali", "person"), sourceId: "late-exact" };
  const near = { ...entry("Moahmmed Ali", "person"), sourceId: "late-near" };
  const index = buildScreeningIndex([
    { version, entries: [...entries, near, exact] },
  ]);
  for (const entityType of ["person", undefined] as const) {
    const result = screen(
      index,
      entityType === undefined
        ? { name: "Mohammed Ali" }
        : { name: "Mohammed Ali", entityType },
      { cutoff: 0.5 },
    ).unwrap();
    expect(
      result.possibleMatches.map(({ entry: listed }) => listed.sourceId),
    ).toContain("late-exact");
    expect(
      result.possibleMatches.map(({ entry: listed }) => listed.sourceId),
    ).toContain("late-near");
    expect(result.totalMatches).toBeGreaterThanOrEqual(200);
    expect(result.truncated).toBe(true);
  }
});

test("deduplicated words preserve the original adjacency graph", () => {
  const reading = nameReading("Abu Bakr Abu Ali", "person");
  expect(reading.tokens.map(({ raw }) => raw)).toEqual(["abu", "bakr", "ali"]);
  expect(reading.adjacent).toEqual([
    [0, 1],
    [1, 0],
    [0, 2],
  ]);
  expect(reading.adjacent).not.toContainEqual([1, 2]);
});

test("optimistic candidate filtering preserves exhaustive cutoff matches", () => {
  const names = [
    "Abu Bakr Abu Ali",
    "Mohammed Ali",
    "Mohamed Alie",
    "Abdul Rahman",
    "Abdulrahman",
    "Sergey Ivanov",
    "Ivan Sergey Ivanov",
    "𐐀𐐁 Ivanov",
  ];
  const index = buildScreeningIndex([
    { version, entries: names.map((name) => entry(name, "person")) },
  ]);
  let qualifying = 0;
  for (const name of names.flatMap((listedName) => [
    listedName,
    listedName.split(" ").toReversed().join(" "),
    listedName.replace("Ali", "Alie"),
  ])) {
    const exhaustive = screen(
      index,
      { name },
      { cutoff: 0, limit: 100 },
    ).unwrap();
    expect(exhaustive.truncated).toBe(false);
    const expected = exhaustive.possibleMatches
      .filter(({ score }) => score >= DEFAULT_CUTOFF)
      .map(({ entry: listed }) => listed.sourceId);
    qualifying += expected.length;
    const filtered = screen(
      index,
      { name },
      { cutoff: DEFAULT_CUTOFF, limit: 100 },
    ).unwrap();
    expect(
      filtered.possibleMatches.map(({ entry: listed }) => listed.sourceId),
    ).toEqual(expected);
  }
  expect(qualifying).toBeGreaterThan(0);
});

test("long names remain screenable and register names cannot become input errors", () => {
  const long =
    "Abu Muhammad Abd al-Rahman bin Ali bin Muhammad al-Hashimi al-Qurashi";
  const registered = Array.from(
    { length: 30 },
    (_, index) => `Word${index}`,
  ).join(" ");
  const index = buildScreeningIndex([
    {
      version,
      entries: [entry(long, "person"), entry(registered, "organisation")],
    },
  ]);
  expect(
    screen(
      index,
      { name: long, entityType: "person" },
      { cutoff: DEFAULT_CUTOFF },
    ).unwrap().totalMatches,
  ).toBe(1);
  const result = screen(
    index,
    { name: registered, entityType: "organisation", nameSource: "register" },
    { cutoff: DEFAULT_CUTOFF },
  );
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.totalMatches).toBe(1);
  }
  const rejected = screen(
    index,
    { name: registered, entityType: "organisation" },
    { cutoff: DEFAULT_CUTOFF },
  );
  expect(rejected.isErr() && rejected.error.code).toBe("excess-query-tokens");
});

// The oracle exhausts 18 query/identity combinations across every partition;
// allow its comparison time without changing any matcher work or latency bound.
test("identity evidence preserves the exhaustive top matches among dense decoys", () => {
  const birthDate = {
    precision: "day",
    year: 1988,
    month: 7,
    day: 17,
  } as const;
  const fillers = Array.from({ length: 20_000 }, (_, position) =>
    entry(`Distant Enterprise ${position}`, "organisation"),
  );
  const decoys = ["Mohammed", "Sergey"].flatMap((given) =>
    Array.from({ length: 2000 }, (_, position) => ({
      ...entry(
        `${given} Q${position}z ${given === "Mohammed" ? "Ali" : "Ivanov"}`,
        "person",
      ),
      birthDates: [
        {
          precision: "day",
          year: 1960 + ((position * 17) % 21),
          month: 1 + ((position * 7) % 12),
          day: 1 + ((position * 11) % 28),
          circa: false,
        } as const,
      ],
      nationalities: [{ code: "US", name: "United States" } as const],
    })),
  );
  const planted = ["Mohammed Abdallah Ali", "Ivanov Sergey Petrovich"].map(
    (name) => {
      const listed = entry(name, "person");
      listed.birthDates = [{ ...birthDate, circa: false }];
      listed.nationalities = [{ code: "RU", name: "Russia" }];
      return listed;
    },
  );
  const index = buildScreeningIndex([
    { version, entries: [...fillers, ...decoys, ...planted] },
  ]);
  // Partition postings, retaining the full vocabulary and IDF weights. Each
  // relevant partition has fewer patterns than the cap; fillers share an
  // irrelevant partition. Their union is exhaustive for these queries.
  const partitions: ScreeningIndex[] = [];
  for (let start = 0; start < index.names.aliases.length;) {
    const end = start === 0 ? fillers.length : start + 128;
    const from = start;
    const keep = (alias: number) => alias >= from && alias < end;
    const restrictPostings = (postings: typeof index.names.raw.postings) => ({
      *get(id: number) {
        for (const alias of postings.get(id)) {
          if (keep(alias)) {
            yield alias;
          }
        }
      },
      size(id: number) {
        let count = 0;
        for (const alias of postings.get(id)) {
          if (keep(alias)) {
            count += 1;
          }
        }
        return count;
      },
    });
    const restrict = (vocabulary: typeof index.names.raw) => ({
      ...vocabulary,
      postings: restrictPostings(vocabulary.postings),
      joinPostings: restrictPostings(vocabulary.joinPostings),
    });
    partitions.push({
      ...index,
      names: {
        ...index.names,
        raw: restrict(index.names.raw),
        folded: restrict(index.names.folded),
      },
    });
    start = end;
  }
  for (const [name, expectedName] of [
    ["Mohammed Ali", "Mohammed Abdallah Ali"],
    ["Mokhammed Ali", "Mohammed Abdallah Ali"],
    ["Sergey Ivanov", "Ivanov Sergey Petrovich"],
  ] as const) {
    for (const entityType of ["person", undefined] as const) {
      for (const identity of [
        { birthDate },
        { nationality: ["RU"] as const },
        { birthDate, nationality: ["RU"] as const },
      ]) {
        const query = {
          name,
          ...identity,
          ...(entityType === undefined ? {} : { entityType }),
        } satisfies ScreeningQuery;
        const exhaustive = partitions
          .flatMap((partition) => {
            const result = screen(partition, query, {
              cutoff: DEFAULT_CUTOFF,
              limit: 128,
            }).unwrap();
            expect(result.truncated).toBe(false);
            return result.possibleMatches;
          })
          .toSorted(
            (left, right) =>
              right.score - left.score ||
              left.entry.sourceId.localeCompare(right.entry.sourceId),
          )
          .slice(0, 25);
        expect(
          exhaustive.map(({ entry: listed }) => listed.sourceId),
        ).toContain(expectedName);
        const bounded = screen(index, query, {
          cutoff: DEFAULT_CUTOFF,
          limit: 25,
        }).unwrap();
        expect(bounded.truncated).toBe(true);
        expect(bounded.possibleMatches).toEqual(exhaustive);
      }
    }
  }
}, 20_000);

test("a cached fuzzy lookup keeps its own truncation when an earlier token already truncated", () => {
  // Many spellings sharing a stem push each stem lookup past the fuzzy
  // candidate cap, so every lookup of these tokens is itself truncated.
  // Letters only: name normalisation drops digits, which would collapse the
  // variants into one spelling.
  const letters = "abcdefghijklmnopqrst";
  const variants = Array.from(letters).flatMap((first) =>
    Array.from(letters).map((second) => ({
      ...entry(`Novak${first}${second} Smith`, "person"),
      sourceId: `variant-${first}${second}`,
    })),
  );
  const index = buildScreeningIndex([
    {
      version,
      entries: [
        ...variants,
        { ...entry("Novac Smith", "person"), sourceId: "novac" },
        { ...entry("Novak Smith", "person"), sourceId: "novak" },
      ],
    },
  ]);
  // "novac" truncates first, so the shared selection is already partial when
  // "novak" is looked up and cached.
  const first = screen(
    index,
    { name: "Novac Novak" },
    { cutoff: 0.5 },
  ).unwrap();
  expect(first.truncated).toBe(true);
  const replayed = screen(index, { name: "Novak" }, { cutoff: 0.5 }).unwrap();
  expect(replayed.truncated).toBe(true);
});
