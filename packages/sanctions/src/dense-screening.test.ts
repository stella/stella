import { expect, test } from "bun:test";

import type { EntityType, SanctionsEntry } from "./entry";
import { nameReading } from "./normalise";
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
    screen(index, entityType === undefined ? { name } : { name, entityType }, {
      cutoff: DEFAULT_CUTOFF,
    });
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
      expect(milliseconds).toBeLessThan(50);
    }
  }
  console.info(JSON.stringify({ denseNames: timings }));
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
