import { panic } from "better-result";

import { normalizeUnicode } from "@stll/text-normalize";

import type { TitleHeadSpec } from "./provision-citation-profile";

export const ACT_KINDS = ["statute", "decree", "regulation"] as const;

/** Which kind of act a word names: a statute, a decree or a regulation. */
export type ActKind = (typeof ACT_KINDS)[number];

type InstrumentHead = {
  /** One list per noun, its cases in `TITLE_MORPHOLOGY`'s order. */
  forms: readonly (readonly string[])[];
  abbreviations: readonly string[];
};

/** The sole vocabulary for title declension and instrument-kind classification. */
const INSTRUMENT_HEADS = {
  cs: {
    statute: {
      forms: [
        ["zákon", "zákona", "zákonu", "zákoně", "zákonem"],
        ["zákoník", "zákoníku", "zákoníku", "zákoníku", "zákoníkem"],
        ["řád", "řádu", "řádu", "řádu", "řádem"],
      ],
      abbreviations: ["zák."],
    },
    decree: {
      forms: [
        [
          "vyhláška",
          "vyhlášky",
          "vyhlášce",
          "vyhlášce",
          "vyhláškou",
          "vyhlášku",
        ],
      ],
      abbreviations: ["vyhl."],
    },
    regulation: {
      forms: [["nařízení", "nařízení", "nařízení", "nařízení", "nařízením"]],
      abbreviations: ["nař."],
    },
  },
  sk: {
    statute: {
      forms: [
        ["zákon", "zákona", "zákonu", "zákone", "zákonom"],
        ["zákonník", "zákonníka", "zákonníku", "zákonníku", "zákonníkom"],
        ["poriadok", "poriadku", "poriadku", "poriadku", "poriadkom"],
      ],
      abbreviations: ["zák."],
    },
    decree: {
      forms: [
        [
          "vyhláška",
          "vyhlášky",
          "vyhláške",
          "vyhláške",
          "vyhláškou",
          "vyhlášku",
        ],
      ],
      abbreviations: ["vyhl."],
    },
    regulation: {
      forms: [
        ["nariadenie", "nariadenia", "nariadeniu", "nariadení", "nariadením"],
      ],
      abbreviations: ["nar."],
    },
  },
} as const satisfies Record<
  "cs" | "sk",
  Readonly<Record<ActKind, InstrumentHead>>
>;

const instrumentHeadsFor = (
  language: string,
): Readonly<Record<ActKind, InstrumentHead>> | null => {
  switch (language) {
    case "cs":
      return INSTRUMENT_HEADS.cs;
    case "sk":
      return INSTRUMENT_HEADS.sk;
    default:
      return null;
  }
};

/**
 * The nouns a short title can open with, each with every form it declines to.
 * A profile's `titleHeads` are this list, so a head cannot be declined one way
 * for reading a name and another way for writing one.
 */
export const titleHeadsFor = (
  language: "cs" | "sk",
): readonly [TitleHeadSpec, ...TitleHeadSpec[]] => {
  const [statute, ...others] = ACT_KINDS.flatMap((kind) => {
    const { forms, abbreviations }: InstrumentHead =
      INSTRUMENT_HEADS[language][kind];
    return forms.map((cases, index) => ({
      nominative: cases[0] ?? panic("An instrument head has no nominative"),
      forms: [...new Set([...cases, ...(index === 0 ? abbreviations : [])])],
    }));
  });
  return [statute ?? panic("A language has no title heads"), ...others];
};

/** Exact inflections and abbreviations; a sentence-ending period is not a stem. */
export const actKindOf = (
  language: string,
  words: readonly string[],
): ActKind | null => {
  const heads = instrumentHeadsFor(language);
  if (heads === null) {
    return null;
  }
  for (const word of words) {
    const key = normalizeUnicode(word, "NFC").toLowerCase();
    const bare = key.endsWith(".") ? key.slice(0, -1) : key;
    const kind = ACT_KINDS.find(
      (candidate) =>
        heads[candidate].abbreviations.includes(key) ||
        heads[candidate].forms.some((forms) => forms.includes(bare)),
    );
    if (kind !== undefined) {
      return kind;
    }
  }
  return null;
};

type TitleMorphology = {
  complementHead: string;
  adjectives: Readonly<Record<string, readonly string[]>>;
};

const TITLE_MORPHOLOGY = {
  cs: {
    complementHead: "o ",
    adjectives: {
      ý: ["ý", "ého", "ému", "ém", "ým"],
      í: ["í", "ího", "ímu", "ím", "ím"],
    },
  },
  sk: {
    complementHead: "o ",
    adjectives: {
      ý: ["ý", "ého", "ému", "om", "ým"],
      y: ["y", "eho", "emu", "om", "ym"],
    },
  },
} as const satisfies Record<string, TitleMorphology>;

const morphologyFor = (language: string): TitleMorphology | null => {
  switch (language) {
    case "cs":
      return TITLE_MORPHOLOGY.cs;
    case "sk":
      return TITLE_MORPHOLOGY.sk;
    default:
      return null;
  }
};

type ActTitleFormsOptions = {
  language: string;
  shortTitle: string;
};

/**
 * Every case a citing sentence prints a short title in. The words after the
 * noun keep their form; adjectives before it decline with it. A language with
 * no morphology reads a title as stored.
 */
export const actTitleForms = ({
  language,
  shortTitle,
}: ActTitleFormsOptions): readonly string[] => {
  const title = normalizeUnicode(shortTitle, "NFC")
    .replaceAll(/\s+/gu, " ")
    .trim();
  const morphology = morphologyFor(language);
  const instrumentHeads = instrumentHeadsFor(language);
  if (morphology === null || instrumentHeads === null) {
    return title === "" ? [] : [title];
  }
  const heads = ACT_KINDS.flatMap((kind) => instrumentHeads[kind].forms);
  const words = title.split(" ");
  const firstWord = words.at(0)?.toLowerCase() ?? "";
  const headCases = heads.find((cases) => cases.includes(firstWord));
  const complement = headCases === undefined ? title : words.slice(1).join(" ");
  if (
    headCases !== undefined ||
    complement.toLowerCase().startsWith(morphology.complementHead)
  ) {
    const cases =
      headCases ??
      instrumentHeads.statute.forms.at(0) ??
      panic("Missing statute head");
    return cases.map((candidate) => `${candidate} ${complement}`);
  }
  const codeHeads = instrumentHeads.statute.forms;
  const nounIndex = words.findIndex((word) =>
    codeHeads.some((cases) => cases.includes(word.toLowerCase())),
  );
  const noun = words[nounIndex]?.toLowerCase() ?? "";
  const cases = codeHeads.find((forms) => forms.includes(noun));
  if (cases === undefined) {
    return title === "" ? [] : [title];
  }
  return cases.map((declined, index) =>
    words
      .map((word, wordIndex) => {
        if (wordIndex === nounIndex) {
          return declined;
        }
        if (wordIndex > nounIndex) {
          return word;
        }
        const suffix = word.at(-1)?.toLowerCase() ?? "";
        const adjective = morphology.adjectives[suffix];
        if (adjective !== undefined) {
          const ending = adjective[index] ?? panic("Missing adjective case");
          return `${word.slice(0, -1)}${ending}`;
        }
        return word;
      })
      .join(" "),
  );
};

/** How far into a name its noun can stand: `občanský soudní řád`. */
const MAX_WORDS_BEFORE_NOUN = 3;

/**
 * Whether a stored name reads as a short title a court prints, stating what
 * kind of act it is: `zákon o advokacii`, `daňový řád`. Not a bare subject (`o
 * advokacii`), which fits any sentence about it, nor a long title that only
 * mentions a kind (`kterým se mění zákon …`). A language without a vocabulary
 * has none.
 */
export const isCitableActName = (language: string, name: string): boolean => {
  const heads = instrumentHeadsFor(language);
  if (heads === null) {
    return false;
  }
  const nouns = ACT_KINDS.flatMap((kind) =>
    heads[kind].forms.flatMap((cases) => [...cases]),
  );
  const words = normalizeUnicode(name, "NFC")
    .trim()
    .toLowerCase()
    .split(/\s+/u);
  const noun = words.findIndex((word) => nouns.includes(word));
  return (
    noun !== -1 &&
    noun <= MAX_WORDS_BEFORE_NOUN &&
    !words.slice(0, noun).includes("o")
  );
};

/**
 * A title's name without the clause that only amends other acts (`o ochraně
 * osobních údajů a o změně některých zákonů` → `o ochraně osobních údajů`),
 * which is how a court prints it. Null when there is no such clause, or
 * nothing before it.
 */
export const nameBeforeAmendingClause = (
  name: string,
  openers: readonly string[],
): string | null => {
  const lower = name.toLowerCase();
  let start = name.length;
  for (const opener of openers) {
    const at = lower.indexOf(` ${opener.toLowerCase()} `);
    if (at !== -1 && at < start) {
      start = at;
    }
  }
  const before = name.slice(0, start).trim();
  return start === name.length || before === "" ? null : before;
};

/**
 * The first day a citation can mean an act: the year it was issued, read off
 * its ELI. Not the first version a corpus holds, which can be decades later
 * than a decision citing the act. Null where the ELI states no year.
 */
export const actIssuedFrom = (eli: string): string | null => {
  const year = /\/(?<year>\d{4})\/\d+(?:\/|$)/u.exec(eli)?.groups?.["year"];
  return year === undefined ? null : `${year}-01-01`;
};

/** The later end of two versions of an act; an open version never ends. */
export const laterValidityEnd = (
  left: string | null,
  right: string | null,
): string | null => {
  if (left === null || right === null) {
    return null;
  }
  return left > right ? left : right;
};

/** An act a name fits, and the half-open dates a citation can mean it. */
export type NamedActCandidate<Act> = {
  act: Act;
  citedFrom: string | null;
  citedUntil: string | null;
};

export type NamedActResolution<Act> =
  | { type: "resolved"; act: Act }
  | {
      type: "unresolved";
      reason:
        "ambiguous-title" | "title-date-not-stated" | "title-outside-validity";
    };

type PickNamedActOptions<Act> = {
  candidates: readonly NamedActCandidate<Act>[];
  /** The citing date. Null never chooses between dated candidates. */
  date: string | null;
  sameAct: (left: Act, right: Act) => boolean;
};

/**
 * The one act a name means on a date, or why it means none. Every reader of an
 * act's name decides here: a wrong statute link is worse than no link, so two
 * acts that fit are never settled by picking one.
 */
export const pickNamedAct = <Act>({
  candidates,
  date,
  sameAct,
}: PickNamedActOptions<Act>): NamedActResolution<Act> => {
  if (
    date === null &&
    candidates.some(
      ({ citedFrom, citedUntil }) => citedFrom !== null || citedUntil !== null,
    )
  ) {
    return { type: "unresolved", reason: "title-date-not-stated" };
  }
  const applicable = candidates.filter(
    ({ citedFrom, citedUntil }) =>
      date === null ||
      ((citedFrom === null || date >= citedFrom) &&
        (citedUntil === null || date < citedUntil)),
  );
  const first = applicable.at(0);
  if (first === undefined) {
    return { type: "unresolved", reason: "title-outside-validity" };
  }
  return applicable.every(({ act }) => sameAct(act, first.act))
    ? { type: "resolved", act: first.act }
    : { type: "unresolved", reason: "ambiguous-title" };
};
