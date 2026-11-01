import { escapeRegExp, stripDiacritics } from "@stll/text-normalize";

const OPINION_HEADING_KINDS = ["dissent", "concurring"] as const;

export type OpinionHeadingKind = (typeof OPINION_HEADING_KINDS)[number];

type OpinionLanguageVocabulary = {
  readonly titles: Readonly<
    Record<OpinionHeadingKind, readonly (readonly [string, string])[]>
  >;
  readonly authors: readonly string[];
  readonly prepositions: readonly string[];
  readonly targets: readonly string[];
  readonly contexts: readonly string[];
  readonly subjects: readonly string[];
};

type OpinionHeadingVocabulary = {
  readonly bareTitles: readonly string[];
  readonly academicTitles: readonly string[];
  readonly languages: Readonly<Record<"cs" | "sk", OpinionLanguageVocabulary>>;
};

/** Title agreement and author inflections belong to the same heading grammar. */
const OPINION_HEADING_VOCABULARY = {
  bareTitles: ["STANOVISKO"],
  academicTitles: ["JUDr.", "Mgr.", "prof.", "doc."],
  languages: {
    cs: {
      titles: {
        dissent: [
          ["Odlišné", "stanovisko"],
          ["Odlišná", "stanoviska"],
          ["Stanovisko", "menšiny"],
        ],
        concurring: [
          ["Paralelní", "stanovisko"],
          ["Paralelní", "stanoviska"],
          ["Konkurující", "stanovisko"],
          ["Konkurující", "stanoviska"],
          ["Souhlasné", "stanovisko"],
          ["Souhlasná", "stanoviska"],
        ],
      },
      authors: [
        "soudce",
        "soudci",
        "soudců",
        "soudkyně",
        "soudkyň",
        "předsedy",
        "předsedkyně",
        "místopředsedy",
        "místopředsedkyně",
        "člena",
        "členů",
        "členky",
        "členek",
      ],
      prepositions: ["k", "ke"],
      targets: [
        "nálezu",
        "usnesení",
        "rozsudku",
        "rozhodnutí",
        "výroku",
        "věci",
        "sp.",
        "č.",
        "§",
        "čl.",
      ],
      contexts: ["ve věci", "podle §"],
      subjects: ["pléna", "menšiny"],
    },
    sk: {
      titles: {
        dissent: [
          ["Odlišné", "stanovisko"],
          ["Odlišné", "stanoviská"],
          ["Stanovisko", "menšiny"],
        ],
        concurring: [
          ["Paralelné", "stanovisko"],
          ["Paralelné", "stanoviská"],
          ["Konkurujúce", "stanovisko"],
          ["Konkurujúce", "stanoviská"],
          ["Súhlasné", "stanovisko"],
          ["Súhlasné", "stanoviská"],
        ],
      },
      authors: [
        "sudcu",
        "sudcov",
        "sudkyne",
        "sudkýň",
        "sudca",
        "sudcovia",
        "sudkyňa",
        "predsedu",
        "predsedníčky",
        "podpredsedu",
        "podpredsedníčky",
        "člena",
        "členov",
        "členky",
        "členiek",
      ],
      prepositions: ["k", "ku"],
      targets: [
        "nálezu",
        "uzneseniu",
        "rozsudku",
        "rozhodnutiu",
        "výroku",
        "veci",
        "sp.",
        "č.",
        "§",
        "čl.",
      ],
      contexts: ["vo veci", "podľa §"],
      subjects: ["pléna", "menšiny"],
    },
  },
} as const satisfies OpinionHeadingVocabulary;

const languages = Object.values(OPINION_HEADING_VOCABULARY.languages);

const foldedAlternation = (forms: readonly string[]): string =>
  [
    ...new Set(
      forms.map((form) =>
        escapeRegExp(stripDiacritics(form)).replace(/ /gu, "\\s+"),
      ),
    ),
  ].join("|");

const titlePatternOf = (kind: OpinionHeadingKind): string =>
  foldedAlternation(
    languages.flatMap(({ titles }) =>
      titles[kind].map((words) => words.join(" ")),
    ),
  );
const authorPattern = foldedAlternation([
  ...languages.flatMap(({ authors }) => authors),
  ...OPINION_HEADING_VOCABULARY.academicTitles.flatMap((title) => [
    title,
    title.replace(/\.$/u, ""),
  ]),
]);
const contextForms = languages.flatMap(
  ({ prepositions, targets, contexts, subjects }) => [
    ...prepositions.flatMap((preposition) =>
      targets.map((target) => `${preposition} ${target}`),
    ),
    ...contexts,
    ...subjects,
  ],
);
const endsWithWord = (form: string): boolean => /\p{L}$/u.test(form);
const wordContextPattern = foldedAlternation(contextForms.filter(endsWithWord));
const referenceContextPattern = foldedAlternation(
  contextForms.filter((form) => !endsWithWord(form)),
);

const TITLE_RE = {
  dissent: new RegExp(`^(?:${titlePatternOf("dissent")})$`, "iu"),
  concurring: new RegExp(`^(?:${titlePatternOf("concurring")})$`, "iu"),
} satisfies Record<OpinionHeadingKind, RegExp>;
const EMPTY_TAIL_RE = /^\s*[.:]?$/u;
const TAIL_RE = new RegExp(
  `^(?:\\s*[.:]?$|\\s+(?:(?:${authorPattern}|${wordContextPattern})(?=$|[\\s,.:])|${referenceContextPattern}))`,
  "iu",
);
const NAMES_AUTHOR_RE = new RegExp(
  `(?:^|\\s)(?:${authorPattern})(?=$|[\\s,.:])`,
  "iu",
);

const AUTHOR_LINE_RE = new RegExp(`^(?:${authorPattern})(?=$|[\\s,.:])`, "iu");

/** Capture the original tail before folding, including decomposed diacritics. */
const HEADING_WORDS_RE =
  /^(?<first>[\p{L}\p{M}]+)\s+(?<second>[\p{L}\p{M}]+)(?<tail>(?:[^\p{L}\p{M}\r\n].*)?)$/u;

const AUTHOR_WORDS: ReadonlySet<string> = new Set(
  languages.flatMap(({ authors }) => authors.map(stripDiacritics)),
);
const ACADEMIC_TITLES: ReadonlySet<string> = new Set(
  OPINION_HEADING_VOCABULARY.academicTitles.map(stripDiacritics),
);

/**
 * Whether a tail attributes the opinion: an author noun or an academic title
 * followed by a capitalized name ("soudce Jana Nováka", "JUDr. Novák") or
 * ending the heading, whose next line names the author ("soudkyně"). An
 * author noun a lowercase word qualifies is generic ("soudce prvního
 * stupně").
 */
const namesAuthorByName = (tail: string): boolean => {
  const words = stripDiacritics(tail)
    .split(/[\s,]+/u)
    .filter((word) => word.length > 0);
  return words.some((word, index) => {
    const next = words[index + 1];
    return (
      (AUTHOR_WORDS.has(word.toLowerCase()) || ACADEMIC_TITLES.has(word)) &&
      (next === undefined || /^\p{Lu}/u.test(next))
    );
  });
};

/** Whether a validated heading tail explicitly names an opinion's author. */
export const separateOpinionHeadingNamesAuthor = (tail: string): boolean =>
  NAMES_AUTHOR_RE.test(stripDiacritics(tail));

/** Whether a line after a bare title begins by naming its author. */
export const separateOpinionAuthorLine = (text: string): boolean =>
  AUTHOR_LINE_RE.test(stripDiacritics(text));

/** A separate opinion's heading: whether it dissents or concurs, and the
 * original text after its title. */
export type SeparateOpinionHeading = {
  readonly kind: OpinionHeadingKind;
  readonly tail: string;
};

/**
 * Read a CS/SK separate-opinion heading: its kind and the original text
 * after its title. A sentence
 * such as "Odlišné stanovisko odůvodňuji takto:" remains prose. The caller
 * supplies its court's heading length bound; bare uppercase STANOVISKO is
 * the older plenary heading whose authors follow on their own lines.
 */
export const separateOpinionHeading = (
  plainText: string,
  maxChars: number,
): SeparateOpinionHeading | undefined => {
  if (plainText.length > maxChars) {
    return undefined;
  }
  // The bare plenary heading introduces the dissenting judges.
  if (
    OPINION_HEADING_VOCABULARY.bareTitles.some((title) => title === plainText)
  ) {
    return { kind: "dissent", tail: "" };
  }
  const groups = HEADING_WORDS_RE.exec(plainText)?.groups;
  const first = groups?.["first"];
  const second = groups?.["second"];
  const tail = groups?.["tail"];
  if (
    first === undefined ||
    second === undefined ||
    tail === undefined ||
    !TAIL_RE.test(stripDiacritics(tail))
  ) {
    return undefined;
  }
  const title = stripDiacritics(`${first} ${second}`);
  const kind = OPINION_HEADING_KINDS.find((candidate) =>
    TITLE_RE[candidate].test(title),
  );
  if (kind === undefined) {
    return undefined;
  }
  // Consent from an administrative authority uses the same concurring title.
  // A legal context, or an author noun naming no one ("k rozhodnutí soudce
  // prvního stupně"), therefore cannot establish a separate opinion.
  if (
    kind === "concurring" &&
    !EMPTY_TAIL_RE.test(tail) &&
    !namesAuthorByName(tail)
  ) {
    return undefined;
  }
  return { kind, tail };
};
