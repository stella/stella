import { escapeRegExp, stripDiacritics } from "@stll/text-normalize";

const OPINION_HEADING_KINDS = ["dissent", "concurring"] as const;

type OpinionHeadingKind = (typeof OPINION_HEADING_KINDS)[number];

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

const titlePattern = foldedAlternation(
  languages.flatMap(({ titles }) => {
    const forms: string[] = [];
    for (const kind of OPINION_HEADING_KINDS) {
      for (const words of titles[kind]) {
        forms.push(words.join(" "));
      }
    }
    return forms;
  }),
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

const TITLE_RE = new RegExp(`^(?:${titlePattern})$`, "iu");
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
  /^(?<first>[\p{L}\p{M}]+)\s+(?<second>[\p{L}\p{M}]+)(?<tail>.*)$/u;

/** Whether a validated heading tail explicitly names an opinion's author. */
export const separateOpinionHeadingNamesAuthor = (tail: string): boolean =>
  NAMES_AUTHOR_RE.test(stripDiacritics(tail));

/** Whether a line after a bare title begins by naming its author. */
export const separateOpinionAuthorLine = (text: string): boolean =>
  AUTHOR_LINE_RE.test(stripDiacritics(text));

/**
 * Return the original text after a CS/SK separate-opinion title. A sentence
 * such as "Odlišné stanovisko odůvodňuji takto:" remains prose. The caller
 * supplies its court's heading length bound; bare uppercase STANOVISKO is
 * the older plenary heading whose authors follow on their own lines.
 */
export const separateOpinionHeadingTail = (
  plainText: string,
  maxChars: number,
): string | undefined => {
  if (plainText.length > maxChars) {
    return undefined;
  }
  if (
    OPINION_HEADING_VOCABULARY.bareTitles.some((title) => title === plainText)
  ) {
    return "";
  }
  const groups = HEADING_WORDS_RE.exec(plainText)?.groups;
  const first = groups?.["first"];
  const second = groups?.["second"];
  const tail = groups?.["tail"];
  if (
    first === undefined ||
    second === undefined ||
    tail === undefined ||
    !TITLE_RE.test(stripDiacritics(`${first} ${second}`)) ||
    !TAIL_RE.test(stripDiacritics(tail))
  ) {
    return undefined;
  }
  return tail;
};
