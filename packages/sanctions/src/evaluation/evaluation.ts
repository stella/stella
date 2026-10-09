import { stripUnicodeMarks } from "@stll/text-normalize";

import type {
  BirthDate,
  EntityType,
  ParsedList,
  SanctionsEntry,
} from "../entry";
import { nameTokens } from "../normalise";
import { buildScreeningIndex, screen } from "../screening";
import type { ScreeningIndex, ScreeningQuery } from "../screening";

// Evaluation set built from the lists themselves. Positives are listed names
// seen through realistic variation, including a stale birth date on the
// client side; negatives are plausible names of people who are not listed.
// A misspelt listed name with another birth date may be someone else or the
// listed person with a wrong record, so it is ambiguous: reported on its own
// and counted neither way.

type CaseKind = "positive" | "negative" | "ambiguous";

const CATEGORY_KINDS = {
  "held-out-variant": "positive",
  "held-out-cyrillic": "positive",
  "diacritics-dropped": "positive",
  "word-order": "positive",
  "missing-middle-name": "positive",
  typo: "positive",
  transliteration: "positive",
  "typo-with-birth-date": "positive",
  "stale-birth-date": "positive",
  "common-name": "negative",
  "common-name-with-birth-date": "negative",
  "misspelt-with-other-birth-date": "ambiguous",
} as const satisfies Record<string, CaseKind>;

type Category = keyof typeof CATEGORY_KINDS;

type EvaluationCase = {
  category: Category;
  query: ScreeningQuery;
  /** `source:sourceId` of the listed entry the case is built from, if any. */
  expected: string | null;
  /** A listed name removed from the expected entry before screening. */
  heldOut: string | null;
};

const FIRST_NAMES = [
  "Jan",
  "Petr",
  "Josef",
  "Pavel",
  "Tomáš",
  "Jiří",
  "Lukáš",
  "Ondřej",
  "Eva",
  "Jana",
  "Hana",
  "Lucie",
  "Kateřina",
  "Tereza",
  "Zdeněk",
  "Miroslav",
  "Juraj",
  "Ľubomír",
  "Zuzana",
  "Mária",
  "Aleksey",
  "Dmitriy",
  "Sergey",
  "Andrey",
  "Nikolay",
  "Yevgeniy",
  "Olga",
  "Tatyana",
  "Irina",
  "Svetlana",
  "Omar",
  "Khalid",
  "Tariq",
  "Youssef",
  "Karim",
  "Samir",
  "Nabil",
  "Walid",
  "Layla",
  "Amina",
  "Rania",
  "Salma",
];

const SURNAMES = [
  "Novák",
  "Svoboda",
  "Novotný",
  "Dvořák",
  "Černý",
  "Procházka",
  "Kučera",
  "Veselý",
  "Horák",
  "Pokorný",
  "Pospíšil",
  "Hájek",
  "Jelínek",
  "Růžička",
  "Beneš",
  "Fiala",
  "Sedláček",
  "Kováč",
  "Varga",
  "Baláž",
  "Molnár",
  "Lukáč",
  "Smirnov",
  "Kuznetsov",
  "Popov",
  "Sokolov",
  "Fyodorov",
  "Morozov",
  "Volkov",
  "Lebedev",
  "Semyonov",
  "Yegorov",
  "Pavlov",
  "Kozlov",
  "Haddad",
  "Khoury",
  "Mansour",
  "Barakat",
  "Darwish",
  "Farah",
  "Najjar",
  "Sabbagh",
  "Shaheen",
  "Tamimi",
];

const TRANSLITERATIONS: readonly (readonly [RegExp, string])[] = [
  [/ov\b/u, "off"],
  [/ev\b/u, "eff"],
  [/kh/u, "ch"],
  [/y(?=[aeiou])/u, "j"],
  [/j(?=[aeiou])/u, "y"],
  [/ks/u, "x"],
  [/x/u, "ks"],
  [/sh/u, "sch"],
  [/ch/u, "tch"],
  [/iy\b/u, "ij"],
  [/v\b/u, "w"],
  [/ou/u, "u"],
  [/ya/u, "ia"],
  [/yu/u, "iu"],
  [/mm/u, "m"],
  [/ee/u, "i"],
];

const CYRILLIC = /\p{Script=Cyrillic}/u;

// Park-Miller minimal standard generator: deterministic, so a seed
// reproduces the same evaluation set.
const MODULUS = 2_147_483_647;
const MULTIPLIER = 48_271;

const random = (seed: number) => {
  let state = (Math.abs(Math.trunc(seed)) % (MODULUS - 1)) + 1;
  return () => {
    state = (state * MULTIPLIER) % MODULUS;
    return (state - 1) / (MODULUS - 1);
  };
};

type Random = ReturnType<typeof random>;

const pick = <T>(draw: Random, values: readonly T[]): T | undefined =>
  values[Math.floor(draw() * values.length)];

const shuffle = <T>(draw: Random, values: readonly T[]): T[] =>
  values
    .map((value) => ({ value, key: draw() }))
    .toSorted((left, right) => left.key - right.key)
    .map(({ value }) => value);

const entryKey = (entry: SanctionsEntry): string =>
  `${entry.source}:${entry.sourceId}`;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Order-free comparison key for "is this name already listed". */
const nameKey = (name: string, entityType: EntityType): string =>
  nameTokens(name, entityType)
    .map((token) => token.folded)
    .toSorted()
    .join(" ");

/** One random edit (substitution, deletion, insertion or transposition). */
const typo = (draw: Random, name: string): string | null => {
  const words = name.split(" ");
  const candidates = words
    .map((word, index) => ({ word, index }))
    .filter(({ word }) => /^\p{L}{5,}$/u.test(word));
  const target = pick(draw, candidates);
  if (target === undefined) {
    return null;
  }
  const { word, index } = target;
  const at = 1 + Math.floor(draw() * (word.length - 2));
  const letter = pick(draw, Array.from(LETTERS)) ?? "a";
  const edits = [
    word.slice(0, at) + letter + word.slice(at + 1),
    word.slice(0, at) + word.slice(at + 1),
    word.slice(0, at) + letter + word.slice(at),
    word.slice(0, at) +
      (word[at + 1] ?? "") +
      (word[at] ?? "") +
      word.slice(at + 2),
  ];
  const edited = pick(draw, edits) ?? word;
  if (edited.toLowerCase() === word.toLowerCase()) {
    return null;
  }
  words[index] = edited;
  return words.join(" ");
};

const dropDiacritics = (name: string): string =>
  stripUnicodeMarks(name, { form: "NFD", markClass: "combining" });

type Listed = { entry: SanctionsEntry; name: string };

type DayBirthDate = Extract<BirthDate, { precision: "day" }>;

const dayBirthDate = (entry: SanctionsEntry): DayBirthDate | undefined =>
  entry.birthDates.find(
    (date): date is DayBirthDate => date.precision === "day" && !date.circa,
  );

const otherBirthDate = (draw: Random, year: number) => ({
  year: year + (draw() < 0.5 ? -1 : 1) * (3 + Math.floor(draw() * 12)),
  month: 1 + Math.floor(draw() * 12),
  day: 1 + Math.floor(draw() * 28),
});

type GenerateOptions = { seed: number; perCategory: number };

export const generateCases = (
  lists: readonly ParsedList[],
  { seed, perCategory }: GenerateOptions,
): EvaluationCase[] => {
  const draw = random(seed);
  const entries = lists.flatMap((list) => list.entries);
  const listedKeys = new Set(
    entries.flatMap((entry) =>
      entry.names.map(({ name }) => nameKey(name, entry.entityType)),
    ),
  );
  const strong: Listed[] = entries.flatMap((entry) =>
    entry.names
      .filter(
        ({ quality, name }) => quality === "strong" && !CYRILLIC.test(name),
      )
      .map(({ name }) => ({ entry, name })),
  );
  const persons = strong.filter(({ entry }) => entry.entityType === "person");
  const cases: EvaluationCase[] = [];
  const take = (
    category: Category,
    pool: readonly Listed[],
    toCase: (listed: Listed) => Omit<EvaluationCase, "category"> | null,
  ) => {
    let taken = 0;
    for (const listed of shuffle(draw, pool)) {
      if (taken >= perCategory) {
        return;
      }
      const made = toCase(listed);
      if (made !== null) {
        cases.push({ category, ...made });
        taken += 1;
      }
    }
  };
  const positive = (listed: Listed, query: ScreeningQuery) => ({
    query,
    expected: entryKey(listed.entry),
    heldOut: null,
  });

  // Held-out names: one strong alias per listed person leaves the index, and
  // the query spells the person that way. Only aliases that look like
  // spelling variants of a remaining one (a shared four-letter token prefix)
  // qualify, so a nickname with nothing in common is not scored as a miss.
  // Organisations are left out: their extra aliases are mostly translations
  // into other languages, which no spelling tolerance bridges.
  const heldOut = (cyrillic: boolean) =>
    entries.flatMap((entry) => {
      if (entry.entityType !== "person") {
        return [];
      }
      const keyed = entry.names
        .filter(({ quality }) => quality === "strong")
        .map(({ name }) => ({
          name,
          tokens: nameTokens(name, entry.entityType).map(
            (token) => token.folded,
          ),
        }));
      return keyed
        .filter(({ name }) => CYRILLIC.test(name) === cyrillic)
        .filter(({ tokens }) => {
          const others = keyed.filter(
            (other) => other.tokens.join(" ") !== tokens.join(" "),
          );
          const prefixes = new Set(
            others.flatMap((other) =>
              other.tokens.map((token) => token.slice(0, 4)),
            ),
          );
          return (
            others.length > 0 &&
            tokens.some(
              (token) => token.length >= 4 && prefixes.has(token.slice(0, 4)),
            )
          );
        })
        .map(({ name }) => ({ entry, name }));
    });
  const usedForHoldOut = new Set<string>();
  const holdOut = (listed: Listed) => {
    const key = entryKey(listed.entry);
    if (usedForHoldOut.has(key)) {
      return null;
    }
    usedForHoldOut.add(key);
    return {
      query: { name: listed.name },
      expected: key,
      heldOut: listed.name,
    };
  };
  take("held-out-variant", heldOut(false), holdOut);
  take("held-out-cyrillic", heldOut(true), holdOut);

  take("diacritics-dropped", strong, (listed) => {
    const stripped = dropDiacritics(listed.name);
    return stripped === listed.name
      ? null
      : positive(listed, { name: stripped });
  });
  take("word-order", strong, (listed) => {
    const words = listed.name.split(" ");
    return words.length < 2
      ? null
      : positive(listed, { name: words.toReversed().join(" ") });
  });
  take("missing-middle-name", persons, (listed) => {
    const words = listed.name.split(" ");
    if (words.length < 3) {
      return null;
    }
    const drop = 1 + Math.floor(draw() * (words.length - 2));
    return positive(listed, {
      name: words.filter((_, index) => index !== drop).join(" "),
    });
  });
  take("typo", strong, (listed) => {
    const name = typo(draw, listed.name);
    return name === null ? null : positive(listed, { name });
  });
  take("transliteration", persons, (listed) => {
    const lower = listed.name.toLowerCase();
    const rules = TRANSLITERATIONS.filter(([pattern]) => pattern.test(lower));
    const rule = pick(draw, rules);
    return rule === undefined
      ? null
      : positive(listed, { name: lower.replace(rule[0], () => rule[1]) });
  });
  take("typo-with-birth-date", persons, (listed) => {
    const born = dayBirthDate(listed.entry);
    const name = typo(draw, listed.name);
    return born === undefined || name === null
      ? null
      : positive(listed, {
          name,
          entityType: "person",
          birthDate: { year: born.year, month: born.month, day: born.day },
        });
  });

  take("stale-birth-date", persons, (listed) => {
    const born = dayBirthDate(listed.entry);
    return born === undefined
      ? null
      : positive(listed, {
          name: listed.name,
          entityType: "person",
          birthDate: otherBirthDate(draw, born.year),
        });
  });

  take("misspelt-with-other-birth-date", persons, (listed) => {
    const born = dayBirthDate(listed.entry);
    const name = typo(draw, listed.name);
    return born === undefined || name === null
      ? null
      : positive(listed, {
          name,
          entityType: "person",
          birthDate: otherBirthDate(draw, born.year),
        });
  });

  const common = (withBirthDate: boolean) => {
    let made = 0;
    while (made < perCategory) {
      const name = `${pick(draw, FIRST_NAMES) ?? ""} ${pick(draw, SURNAMES) ?? ""}`;
      if (listedKeys.has(nameKey(name, "person"))) {
        continue;
      }
      const birthDate = withBirthDate ? otherBirthDate(draw, 1965) : undefined;
      cases.push({
        category: withBirthDate ? "common-name-with-birth-date" : "common-name",
        query:
          birthDate === undefined
            ? { name, entityType: "person" }
            : { name, entityType: "person", birthDate },
        expected: null,
        heldOut: null,
      });
      made += 1;
    }
  };
  common(false);
  common(true);
  return cases;
};

const withoutHeldOut = (
  lists: readonly ParsedList[],
  cases: readonly EvaluationCase[],
): ParsedList[] => {
  const removed = new Map(
    cases.flatMap((testCase) =>
      testCase.heldOut === null || testCase.expected === null
        ? []
        : [[testCase.expected, testCase.heldOut] as const],
    ),
  );
  return lists.map((list) => ({
    version: list.version,
    entries: list.entries.map((entry) => {
      const name = removed.get(entryKey(entry));
      return name === undefined
        ? entry
        : {
            ...entry,
            names: entry.names.filter((listed) => listed.name !== name),
          };
    }),
  }));
};

type CaseOutcome = {
  testCase: EvaluationCase;
  kind: CaseKind;
  /** Whether the expected entry, or for negatives any entry, was reported. */
  flagged: boolean;
  alerts: number;
  milliseconds: number;
};

type CutoffRow = {
  cutoff: number;
  precision: number;
  recall: number;
  falsePositiveRate: number;
  /** Share of ambiguous cases flagged; neither a hit nor a false alarm. */
  ambiguousFlagRate: number;
  alertsPerQuery: number;
  byCategory: Record<string, number>;
};

type EvaluationReport = {
  rows: CutoffRow[];
  milliseconds: number[];
};

const runCases = (
  index: ScreeningIndex,
  cases: readonly EvaluationCase[],
  cutoff: number,
): CaseOutcome[] =>
  cases.map((testCase) => {
    const started = performance.now();
    const result = screen(index, testCase.query, { cutoff, limit: 50 });
    const milliseconds = performance.now() - started;
    const matches = result.isOk() ? result.value.possibleMatches : [];
    return {
      testCase,
      kind: CATEGORY_KINDS[testCase.category],
      flagged: matches.some(
        (match) =>
          testCase.expected === null ||
          entryKey(match.entry) === testCase.expected,
      ),
      alerts: result.isOk() ? result.value.totalMatches : 0,
      milliseconds,
    };
  });

/**
 * Screens every case at each cutoff (a strong name match with conflicting
 * client fields is kept at the cutoff itself, so reports do not nest) and
 * derives precision and recall (positives against negatives), the false
 * positive rate, the flag rate of ambiguous cases, alert volume over all
 * cases, and the flag rate per category.
 */
export const evaluate = (
  lists: readonly ParsedList[],
  cases: readonly EvaluationCase[],
  cutoffs: readonly number[],
): EvaluationReport => {
  const heldOut = cases.filter((testCase) => testCase.heldOut !== null);
  const kept = cases.filter((testCase) => testCase.heldOut === null);
  const fullIndex = buildScreeningIndex(lists);
  const heldOutIndex = buildScreeningIndex(withoutHeldOut(lists, heldOut));
  const runs = cutoffs.map((cutoff) => ({
    cutoff,
    outcomes: [
      ...runCases(fullIndex, kept, cutoff),
      ...runCases(heldOutIndex, heldOut, cutoff),
    ],
  }));
  const rows = runs.map(({ cutoff, outcomes }) => {
    const flagged = (outcome: CaseOutcome) => outcome.flagged;
    const ofKind = (kind: CaseKind) =>
      outcomes.filter((outcome) => outcome.kind === kind);
    const positives = ofKind("positive");
    const negatives = ofKind("negative");
    const ambiguous = ofKind("ambiguous");
    const truePositives = positives.filter(flagged).length;
    const falsePositives = negatives.filter(flagged).length;
    const byCategory: Record<string, number> = {};
    for (const category of Object.keys(CATEGORY_KINDS)) {
      const inCategory = outcomes.filter(
        (outcome) => outcome.testCase.category === category,
      );
      if (inCategory.length > 0) {
        byCategory[category] =
          inCategory.filter(flagged).length / inCategory.length;
      }
    }
    return {
      cutoff,
      precision: truePositives / Math.max(1, truePositives + falsePositives),
      recall: truePositives / Math.max(1, positives.length),
      falsePositiveRate: falsePositives / Math.max(1, negatives.length),
      ambiguousFlagRate:
        ambiguous.filter(flagged).length / Math.max(1, ambiguous.length),
      alertsPerQuery:
        outcomes.reduce((sum, outcome) => sum + outcome.alerts, 0) /
        Math.max(1, outcomes.length),
      byCategory,
    };
  });
  return {
    rows,
    milliseconds: (runs[0]?.outcomes ?? []).map(
      (outcome) => outcome.milliseconds,
    ),
  };
};
