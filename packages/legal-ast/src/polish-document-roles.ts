// parser-output-unchanged: [pl-uodo] only reads signature lines by title and name, which the data-protection reader does not call.
/**
 * How a Polish decision names its own parts: the operative verbs its ruling
 * opens with, the reasons heading, the recital before the ruling, the closing
 * and the signatures after it.
 *
 * One grammar for every Polish parser (common courts, the procurement
 * chamber, the authorities, the tax rulings), so a form of words one source
 * teaches is read the same way by the others. Every predicate reads a line
 * with its letter spacing collapsed: courts space a heading out for emphasis
 * (`U z a s a d n i e n i e`), and the spaced line is the same heading.
 */

import { panic } from "better-result";

import { collapseSpacedLetters } from "@stll/text-normalize";

/**
 * A line as the grammar reads it: spaced letters joined, whitespace single.
 * A gap wider than one space, or a line break, separates words, so spaced
 * letters are joined before the whitespace collapses.
 */
const grammarLine = (text: string): string =>
  collapseSpacedLetters(text.replaceAll(/[^\S ]+/gu, "  "))
    .replaceAll(/\s+/gu, " ")
    .trim();

/** Third-person and infinitive forms used at the opening of Polish rulings. */
type PolishVerbInflection =
  | "final-ć"
  | "ować-to-uje"
  | "ywać-to-uje"
  | "awać-to-aje"
  | "ąć-to-mie"
  | "zać-to-że"
  | "ść-to-sie"
  | "ec-to-eknie";

type PolishOperativeLemma = {
  readonly lemma: string;
  readonly inflection: PolishVerbInflection;
  readonly polarity?: "positive" | "both";
  readonly particle?: " się";
  readonly holdingHeading?: "bare" | "past";
};

type ReplaceEndingOptions = {
  word: string;
  ending: string;
  replacement: string;
};

const replaceEnding = ({
  word,
  ending,
  replacement,
}: ReplaceEndingOptions): string => {
  if (!word.endsWith(ending)) {
    return panic(`Operative verb does not end with ${ending}`);
  }
  return `${word.slice(0, -ending.length)}${replacement}`;
};

/**
 * Infinitives are the source of both infinitive and finite forms. Aspect
 * pairs stay separate because their finite forms and meanings differ.
 */
const POLISH_OPERATIVE_LEMMAS = [
  { lemma: "oddalać", inflection: "final-ć" },
  { lemma: "oddalić", inflection: "final-ć" },
  { lemma: "zmieniać", inflection: "final-ć" },
  { lemma: "zmienić", inflection: "final-ć" },
  { lemma: "uchylać", inflection: "final-ć" },
  { lemma: "uchylić", inflection: "final-ć" },
  { lemma: "zasądzać", inflection: "final-ć" },
  { lemma: "zasądzić", inflection: "final-ć" },
  { lemma: "stwierdzać", inflection: "final-ć" },
  { lemma: "stwierdzić", inflection: "final-ć" },
  { lemma: "umarzać", inflection: "final-ć" },
  { lemma: "umorzyć", inflection: "final-ć" },
  { lemma: "utrzymywać", inflection: "ywać-to-uje" },
  { lemma: "utrzymać", inflection: "final-ć" },
  { lemma: "nakazywać", inflection: "ywać-to-uje" },
  { lemma: "nakazać", inflection: "zać-to-że" },
  { lemma: "odrzucać", inflection: "final-ć" },
  { lemma: "odrzucić", inflection: "final-ć" },
  { lemma: "ustalać", inflection: "final-ć" },
  { lemma: "ustalić", inflection: "final-ć", holdingHeading: "past" },
  { lemma: "przyjmować", inflection: "ować-to-uje" },
  { lemma: "przyjąć", inflection: "ąć-to-mie" },
  { lemma: "przyznawać", inflection: "awać-to-aje" },
  { lemma: "przyznać", inflection: "final-ć" },
  { lemma: "odmawiać", inflection: "final-ć" },
  { lemma: "odmówić", inflection: "final-ć" },
  { lemma: "zwracać", inflection: "final-ć", particle: " się" },
  { lemma: "zwrócić", inflection: "final-ć", particle: " się" },
  { lemma: "przekazywać", inflection: "ywać-to-uje" },
  { lemma: "przekazać", inflection: "zać-to-że" },
  { lemma: "obciążać", inflection: "final-ć", polarity: "both" },
  { lemma: "obciążyć", inflection: "final-ć", polarity: "both" },
  { lemma: "znosić", inflection: "final-ć" },
  { lemma: "znieść", inflection: "ść-to-sie" },
  { lemma: "orzekać", inflection: "final-ć", holdingHeading: "bare" },
  { lemma: "orzec", inflection: "ec-to-eknie" },
  { lemma: "uznawać", inflection: "awać-to-aje" },
  { lemma: "uznać", inflection: "final-ć" },
  { lemma: "wymierzać", inflection: "final-ć" },
  { lemma: "wymierzyć", inflection: "final-ć" },
  { lemma: "zwalniać", inflection: "final-ć" },
  { lemma: "zwolnić", inflection: "final-ć" },
  { lemma: "zakazywać", inflection: "ywać-to-uje" },
  { lemma: "zakazać", inflection: "zać-to-że" },
  { lemma: "postanawiać", inflection: "final-ć", holdingHeading: "bare" },
  { lemma: "postanowić", inflection: "final-ć", holdingHeading: "past" },
  { lemma: "uchwalać", inflection: "final-ć", holdingHeading: "bare" },
  { lemma: "uchwalić", inflection: "final-ć", holdingHeading: "past" },
  { lemma: "zarządzać", inflection: "final-ć", holdingHeading: "bare" },
  { lemma: "zarządzić", inflection: "final-ć" },
] as const satisfies readonly PolishOperativeLemma[];

const finiteThirdPersonOf = ({
  lemma,
  inflection,
}: PolishOperativeLemma): string => {
  switch (inflection) {
    case "final-ć":
      return replaceEnding({ word: lemma, ending: "ć", replacement: "" });
    case "ować-to-uje":
      return replaceEnding({ word: lemma, ending: "ować", replacement: "uje" });
    case "ywać-to-uje":
      return replaceEnding({ word: lemma, ending: "ywać", replacement: "uje" });
    case "awać-to-aje":
      return replaceEnding({ word: lemma, ending: "awać", replacement: "aje" });
    case "ąć-to-mie":
      return replaceEnding({ word: lemma, ending: "ąć", replacement: "mie" });
    case "zać-to-że":
      return replaceEnding({ word: lemma, ending: "zać", replacement: "że" });
    case "ść-to-sie":
      return replaceEnding({ word: lemma, ending: "ść", replacement: "sie" });
    case "ec-to-eknie":
      return replaceEnding({ word: lemma, ending: "ec", replacement: "eknie" });
    default:
      inflection satisfies never;
      return panic("Unsupported Polish operative verb inflection");
  }
};

const formsOf = ({
  lemma,
  particle,
  inflection,
  polarity,
}: PolishOperativeLemma): string[] => {
  const finite = finiteThirdPersonOf({ lemma, inflection });
  const forms = [lemma, finite].flatMap((form) =>
    polarity === "both" ? [form, `nie ${form}`] : [form],
  );
  if (particle !== undefined) {
    forms.push(`${lemma}${particle}`, `${finite}${particle}`);
  }
  return forms;
};

const POLISH_OPERATIVE_FORMS = POLISH_OPERATIVE_LEMMAS.flatMap(
  formsOf,
).toSorted((left, right) => right.length - left.length);

const POLISH_OPERATIVE_START = new RegExp(
  `^(?:${POLISH_OPERATIVE_FORMS.join("|")})(?!\\p{L})`,
  "iu",
);

/** Whether text begins with a listed Polish operative verb form. */
export const startsWithPlOperativeVerb = (text: string): boolean =>
  POLISH_OPERATIVE_START.test(grammarLine(text));

const POLISH_OPERATIVE_WORD = new RegExp(
  `(?<!\\p{L})(?:${POLISH_OPERATIVE_FORMS.join("|")})(?!\\p{L})`,
  "iu",
);

/**
 * Whether a line rules: it holds a listed operative verb form anywhere, as
 * a ruling point does that opens on its object ("I. powództwo oddala").
 */
export const containsPlOperativeVerb = (text: string): boolean =>
  POLISH_OPERATIVE_WORD.test(grammarLine(text));

const holdingHeadingForms = POLISH_OPERATIVE_LEMMAS.flatMap((entry) => {
  if (!("holdingHeading" in entry)) {
    return [];
  }
  const forms = [entry.lemma, finiteThirdPersonOf(entry)];
  if (entry.holdingHeading === "past") {
    forms.push(
      replaceEnding({ word: entry.lemma, ending: "ć", replacement: "ł" }),
    );
  }
  return forms;
}).toSorted((left, right) => right.length - left.length);

const POLISH_HOLDING_HEADING = new RegExp(
  `^(?:${holdingHeadingForms.join("|")})(?:\\s*:\\s*)?$`,
  "iu",
);

/** Whether text is a bare Polish operative section heading. */
export const isPlHoldingHeading = (text: string): boolean =>
  POLISH_HOLDING_HEADING.test(grammarLine(text));

const REASONS_HEADING_RE = /^uzasadnienie\b/iu;
// The editor numbers the reasons on from the operative points when they
// share one outline ("V. UZASADNIENIE" after point IV).
const NUMBERED_REASONS_HEADING_RE = /^[IVXLC]+\s*[.)]\s*uzasadnienie$/iu;

/** A ruling point's number, set apart or run on to its verb (`I.zmienia`). */
const RULING_POINT_MARKER_RE = /^(?:[IVXLCDM]+|\d+|[a-z])[.)] ?/u;

/**
 * Whether a line opens a ruling: a holding heading (`postanawia:`), or an
 * operative verb, alone or after the point's number (`1. zasądza`,
 * `I.zmienia`).
 */
export const opensPlRuling = (text: string): boolean => {
  const line = grammarLine(text);
  return (
    isPlHoldingHeading(line) ||
    startsWithPlOperativeVerb(line.replace(RULING_POINT_MARKER_RE, ""))
  );
};

const COMPOSITION_LINE_RE = /\bw składzie(?: następującym)?\s?:/iu;

/** Whether a line opens the bench (`w składzie:`, `w składzie następującym:`). */
export const isPlCompositionLine = (text: string): boolean =>
  COMPOSITION_LINE_RE.test(grammarLine(text));

/** Whether a line opens the reasons (`Uzasadnienie`, `U z a s a d n i e n i e`). */
export const isPlReasonsHeading = (text: string): boolean =>
  REASONS_HEADING_RE.test(grammarLine(text));

/** Whether a line opens the reasons under an outline number (`V. UZASADNIENIE`). */
export const isPlNumberedReasonsHeading = (text: string): boolean =>
  NUMBERED_REASONS_HEADING_RE.test(grammarLine(text));

const OPENING_RECITAL_RE =
  /^(?:po rozpoznaniu|po rozpatrzeniu|po przeprowadzeniu|na posiedzeniu|na rozprawie|w sprawie)\b/iu;

/** Whether a line opens the recital that names the hearing and the case. */
export const isPlOpeningRecital = (text: string): boolean =>
  OPENING_RECITAL_RE.test(grammarLine(text));

const LEGAL_BASIS_RE = /^na podstawie\b/iu;

/**
 * Whether a line is the head matter before the ruling: the recital, or the
 * legal basis the authority decides on (`Na podstawie art. 104 § 1 …`),
 * with no operative verb of its own. The same words inside a ruling point
 * that also rules ("na podstawie art. 4 … umorzyć") are the ruling.
 */
export const isPlRecitalLine = (text: string): boolean => {
  const line = grammarLine(text);
  return (
    (OPENING_RECITAL_RE.test(line) || LEGAL_BASIS_RE.test(line)) &&
    !POLISH_OPERATIVE_WORD.test(line)
  );
};

/**
 * Whether a line is the authority's ruling sentence on its legal basis:
 * the basis, then the operative verb (`Na podstawie art. 14b § 1 … Dyrektor
 * … stwierdza, że stanowisko … jest nieprawidłowe.`). The basis alone is the
 * head matter before the ruling.
 */
export const isPlLegalBasisRuling = (text: string): boolean => {
  const line = grammarLine(text);
  return LEGAL_BASIS_RE.test(line) && POLISH_OPERATIVE_WORD.test(line);
};

/**
 * Whether a line names the document's own declared type, as a title does
 * (`INTERPRETACJA INDYWIDUALNA` for an individual tax interpretation).
 */
export const namesPlDocumentType = (text: string, type: string): boolean => {
  const key = (value: string) =>
    grammarLine(value).replace(/[.:]$/u, "").toLocaleLowerCase("pl-PL");
  return key(type) !== "" && key(text) === key(type);
};

const CLOSING_RE =
  /^[A-ZĄĆĘŁŃÓŚŹŻ][\p{L} .-]+,\s+dnia\s+\d{1,2}\s+\p{L}+\s+\d{4}\s*r?\.?$/u;

/** Whether a line is the closing: the place and the date (`Gliwice, dnia …`). */
export const isPlClosingLine = (text: string): boolean =>
  CLOSING_RE.test(grammarLine(text));

/**
 * The courts a judge's title names, by abbreviation (`Sędzia SO`, `SSO`) or
 * in full (`Sędzia Sądu Okręgowego`).
 */
const PL_TITLE_COURTS = [
  { short: "SN", full: "Sądu Najwyższego" },
  { short: "SA", full: "Sądu Apelacyjnego" },
  { short: "SO", full: "Sądu Okręgowego" },
  { short: "SR", full: "Sądu Rejonowego" },
  { short: "NSA", full: "Naczelnego Sądu Administracyjnego" },
  { short: "WSA", full: "Wojewódzkiego Sądu Administracyjnego" },
] as const;

/**
 * A title a decision is signed under. A judge's, assessor's or registrar's
 * title signs only with a name after it; an office signs printed alone too.
 */
type PlSigningTitle = {
  readonly words: readonly string[];
  readonly signsAlone: boolean;
};

const titleWords = (phrase: string): readonly string[] =>
  phrase.toLocaleLowerCase("pl-PL").split(" ");

/** A person's title: it signs with a name after it. */
const signingTitle = (phrase: string): PlSigningTitle => ({
  words: titleWords(phrase),
  signsAlone: false,
});

/** An office: it signs printed alone, or with a name after it. */
const signingOffice = (phrase: string): PlSigningTitle => ({
  words: titleWords(phrase),
  signsAlone: true,
});

/**
 * Every title a Polish decision is signed under, longest first so that
 * `Sędzia Sądu Okręgowego` is read before `Sędzia`: the abbreviated judge's
 * title (`SSO`, `SNSA`), `Sędzia` alone or with its court, the court
 * assessor (`ASR`, `Asesor sądowy`), the registrar, the presiding judge,
 * and the competition authority's office.
 */
const PL_SIGNING_TITLES: readonly PlSigningTitle[] = [
  ...PL_TITLE_COURTS.flatMap(({ short, full }) => [
    signingTitle(`S${short}`),
    signingTitle(`Sędzia ${short}`),
    signingTitle(`Sędzia ${full}`),
  ]),
  signingTitle("Sędzia"),
  signingTitle("ASR"),
  signingTitle("Asesor sądowy"),
  signingTitle("Referendarz sądowy"),
  signingTitle("Starszy referendarz sądowy"),
  signingTitle("Przewodniczący"),
  signingTitle("Przewodnicząca"),
  signingOffice("Prezes Urzędu Ochrony Konkurencji i Konsumentów"),
].toSorted((left, right) => right.words.length - left.words.length);

/** A judge seconded to another court: `SSO del.`, `SSR (del.)`, `SSA w SO`. */
const SECONDED_MARKS: readonly (readonly string[])[] = [
  ["del."],
  ["(del.)"],
  ...PL_TITLE_COURTS.map(({ short }) => [
    "w",
    short.toLocaleLowerCase("pl-PL"),
  ]),
];

/** A dash set between titles or between the parts of one surname. */
const DASHES: ReadonlySet<string> = new Set(["-", "–"]);
/** Most words one signed name runs to (`Anna Maria Kowalska-Nowak`). */
const SIGNED_NAME_MAX_WORDS = 4;
const NAME_WORD_RE = /^\p{Lu}[\p{L}\p{M}'’.]*(?:-\p{Lu}?[\p{L}\p{M}'’.]*)*$/u;
/** A role beside a signed name: `(spr.)`, `(przewodniczący)`. */
const NAME_NOTE_RE = /^\([^()]*\)$/u;

/** How many words of `phrase` the words at `index` match, or 0. */
const matchesAt = (
  words: readonly string[],
  index: number,
  phrase: readonly string[],
): number =>
  phrase.every(
    (word, offset) =>
      words[index + offset]?.toLocaleLowerCase("pl-PL") === word,
  )
    ? phrase.length
    : 0;

/** The signing title the words at `index` open on, longest first. */
const signingTitleAt = (
  words: readonly string[],
  index: number,
): PlSigningTitle | undefined =>
  PL_SIGNING_TITLES.find((title) => matchesAt(words, index, title.words) > 0);

/** How many words of a seconding mark start at `index`, or 0. */
const secondedMarkWordsAt = (words: readonly string[], index: number): number =>
  SECONDED_MARKS.find((mark) => matchesAt(words, index, mark) > 0)?.length ?? 0;

/** How many words of one signed name start at `index` (`Balion - Hajduk` is one). */
const signedNameWordsAt = (words: readonly string[], index: number): number => {
  let next = index;
  let nameWords = 0;
  while (
    next < words.length &&
    signingTitleAt(words, next) === undefined &&
    NAME_WORD_RE.test(words[next] ?? "")
  ) {
    next += 1;
    nameWords += 1;
    // A surname's parts joined across a spaced dash read as one word.
    while (
      DASHES.has(words[next] ?? "") &&
      NAME_WORD_RE.test(words[next + 1] ?? "")
    ) {
      next += 2;
    }
  }
  return nameWords > SIGNED_NAME_MAX_WORDS ? -1 : next - index;
};

/**
 * Whether a line is only signing titles and names: `SSO Katarzyna Banko`,
 * `Sędzia Przemysław Kociński`, `ASR Maciej Skuczyński`, `SSA Ewa Jastrzębska
 * SSA Małgorzata Wołczańska SSO del. Tomasz Tatarczyk`, `Przewodniczący -
 * Sędzia SO Magdalena Balion - Hajduk`. Read word by word: each signer is
 * one or more titles, a seconding mark, a name of at most four words and a
 * role beside it. A line holding anything else signs nothing, so a sentence
 * that opens on a title (`Prezes Urzędu ustalił, co następuje:`, `SSO Jan
 * Kowalski zasądza …`) is never a signature.
 */
const isTitledSignatureLine = (line: string): boolean => {
  // The line is read with single spaces; a dash with a space on one side
  // only (`Staniszewska- Perenc`) stands apart like a spaced one.
  const words = line
    .replaceAll(/ [-–](?=\S)|(?<=\S)[-–] /gu, (dash) => ` ${dash.trim()} `)
    .split(" ");
  let index = 0;
  while (index < words.length) {
    let signsAlone = false;
    let titles = 0;
    for (
      let title = signingTitleAt(words, index);
      title !== undefined;
      title = signingTitleAt(words, index)
    ) {
      signsAlone ||= title.signsAlone;
      titles += 1;
      index += title.words.length;
      while (DASHES.has(words[index] ?? "")) {
        index += 1;
      }
    }
    if (titles === 0) {
      return false;
    }
    index += secondedMarkWordsAt(words, index);
    const nameLength = signedNameWordsAt(words, index);
    if (nameLength < 0 || (nameLength === 0 && !signsAlone)) {
      return false;
    }
    index += nameLength;
    if (nameLength > 0 && NAME_NOTE_RE.test(words[index] ?? "")) {
      index += 1;
    }
  }
  return words.length > 0;
};

/**
 * A signing label with the place for the signature left blank, or nothing
 * after it: `Przewodniczący:…………`, `Sędzia sprawozdawca:`, `Skład
 * orzekający Izby:`. A label followed by a name (`Przewodniczący: Anna
 * Kowalska`) names the bench in the head matter and is not one.
 */
const SIGNING_LABEL_RE =
  /^(?:przewodnicząc[ya]|członkowie|członek|sędziowie|sędzia(?: sprawozdawca)?|sprawozdawca|skład orzekający(?: izby)?)\s?:?\s?[.…]*$/iu;

/** The place left for a signature: a line of dots alone. */
const SIGNATURE_BLANK_RE = /^[.…]{3,}$/u;

/** Whether a line signs the decision: a bench's names or a signing label. */
export const isPlSignatureLine = (text: string): boolean => {
  const line = grammarLine(text);
  return isTitledSignatureLine(line) || SIGNING_LABEL_RE.test(line);
};

/** Whether a line is the blank a signature is written on. */
export const isPlSignatureBlank = (text: string): boolean =>
  SIGNATURE_BLANK_RE.test(grammarLine(text).replaceAll(" ", ""));

/**
 * The heading the instructions on appeal stand under: `Pouczenie`,
 * `POUCZENIA:`, or with its outline number (`14. Pouczenie`).
 */
const INSTRUCTION_HEADING_RE = /^(?:\d{1,3}\. ?)?pouczeni[ea] ?:?$/iu;

/** Whether a line heads the instructions on appeal. */
export const isPlInstructionHeading = (text: string): boolean =>
  INSTRUCTION_HEADING_RE.test(grammarLine(text));

/** A remedy that lies against a decision, as an instruction states it. */
const REMEDY_LIES_RE =
  /przysługuje(?: stronie| stronom)?,? (?:prawo do wniesienia )?(?:skarg|odwołani|zażaleni|apelacj|kasacj|sprzeciw)/iu;

/** The decision the instruction is about: this one. */
const THIS_DECISION_RE =
  /^(?:na|od) (?:to |tego )?orzeczeni|niniejsz\p{Ll}* (?:decyzj|wyrok|postanowieni|orzeczeni|interpretacj)/iu;

/**
 * Whether a paragraph instructs the parties on the remedy against this
 * decision (`Na orzeczenie … przysługuje skarga …`, `Stosownie do art. 81 …
 * od niniejszej decyzji przysługuje odwołanie …`, `Stronie przysługuje prawo
 * do wniesienia skargi na niniejszą interpretację …`). The instruction is
 * not the ruling and not its reasons.
 */
export const isPlAppealInstruction = (text: string): boolean => {
  const line = grammarLine(text);
  return REMEDY_LIES_RE.test(line) && THIS_DECISION_RE.test(line);
};

/** Where a remedy is filed (`Skargę wnosi się …`), after the instruction. */
const REMEDY_FILING_RE =
  /^(?:skargę|odwołanie|zażalenie|apelację|kasację|sprzeciw) (?:wnosi|składa) się/iu;

/** Whether a line goes on with the instruction: where the remedy is filed. */
export const isPlRemedyFilingLine = (text: string): boolean =>
  REMEDY_FILING_RE.test(grammarLine(text));

/**
 * A line of the head matter naming who sat (`Przewodniczący: Ewa Sikorska`,
 * `Protokolant: Aldona Karpińska`, `Członkowie: …`): a label and the name
 * after it. The same label with a blank after it signs the decision.
 */
const BENCH_MEMBER_LINE_RE =
  /^(?:[Pp]rzewodnicząc[ya]|[Ss]ędzi(?:a|owie)|[Cc]złonk(?:owie|inie)|[Pp]rotokolant(?:ka)?|[Łł]awni(?:k|cy|czka|czki)) ?: ?(?:(?:SS[AONR]|SN|\p{Ll}+\.?) ){0,3}\p{Lu}\p{Ll}/u;

/** Whether a head-matter line names a member of the bench or its clerk. */
export const isPlBenchMemberLine = (text: string): boolean =>
  BENCH_MEMBER_LINE_RE.test(grammarLine(text));

/**
 * The date a decision was given, on a line of its own (`z dnia 4 lutego
 * 2022 r.`, `Warszawa, dnia 1 września 2025 roku`).
 */
const DECISION_DATE_LINE_RE =
  /^(?:\p{Lu}\p{Ll}+, )?(?:z )?dnia \d{1,2}(?:\. ?\d{1,2}\. ?| \p{Ll}+ )\d{4}(?: r\.| roku)?[,;:]?$/iu;

/** Whether a line gives the date of the decision and nothing else. */
export const isPlDecisionDateLine = (text: string): boolean =>
  DECISION_DATE_LINE_RE.test(grammarLine(text));

/**
 * An authority's decision titled by its number: `DECYZJA nr DOK-9/2011`,
 * `DECYZJA Nr RŁO 15/2009`. The line ends on the number; a sentence that
 * names a decision by its number (`Decyzja nr 5 z dnia … została
 * uchylona.`) is no title.
 */
const NUMBERED_DECISION_TITLE_RE =
  /^(?:DECYZJA|Decyzja) (?:NR|Nr|nr)\.? (?:\p{Lu}{2,6}(?: ?- ?| ))?\d{1,4}(?:[./-]\d{1,4}){0,3}$/u;

/**
 * An authority's decision titled by its docket alone, with or without
 * `nr`: `DECYZJA RGD - 1/2026`, `DECYZJA DIH-1/48/2017`.
 */
const DOCKETED_DECISION_TITLE_RE =
  /^(?:DECYZJA|Decyzja) \p{Lu}{2,6}(?: ?- ?| )\d{1,4}(?:\/\d{1,4}){1,2}$/u;

/** Whether a line is the title an authority's decision is printed under. */
export const isPlAuthorityDecisionTitle = (text: string): boolean => {
  const line = grammarLine(text);
  return (
    NUMBERED_DECISION_TITLE_RE.test(line) ||
    DOCKETED_DECISION_TITLE_RE.test(line)
  );
};

/**
 * The clause a recital runs on into when the ruling's verb follows it in the
 * same paragraph: `…, uznaje się, że …` after `po przeprowadzeniu
 * postępowania … przeciwko …`.
 */
const RULING_CLAUSE_RE = new RegExp(
  `, (?=(?:${POLISH_OPERATIVE_FORMS.join("|")})(?!\\p{L}))`,
  "iu",
);

/**
 * Where the ruling starts in a paragraph that opens on the recital and
 * rules in its last clause (`po przeprowadzeniu postępowania … , uznaje się,
 * że …`): the offset of the operative verb, or `undefined` when the
 * paragraph is no such recital or states no ruling.
 */
export const plRulingClauseStart = (text: string): number | undefined => {
  if (!isPlOpeningRecital(text)) {
    return undefined;
  }
  const match = RULING_CLAUSE_RE.exec(text);
  return match === null ? undefined : match.index + match[0].length;
};
