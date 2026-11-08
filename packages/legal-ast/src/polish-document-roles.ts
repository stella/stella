// parser-output-unchanged: [pl-uodo] only adds the ruling, composition, legal-basis ruling and document-type predicates, which the data-protection reader does not call; its recital reading is unchanged.
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
 * A line opening on a judge's title or office (`SSA …`, `Sędzia …`,
 * `Przewodniczący …`). It signs the reasons only where they end; the same
 * opening in the head matter names the bench.
 */
const SIGNATURE_TITLE_RE =
  /^(?:SSA|SSA del\.|SSO|SSR|sędzia|Sędzia|Przewodniczący|Przewodnicząca|Prezes|sprawozdawca)\b/u;

/** Longest line a signature title opening is read on. */
const SIGNATURE_TITLE_LINE_MAX_CHARS = 120;

/** Whether a short line opens on a judge's title or office. */
export const opensWithPlSignatureTitle = (text: string): boolean => {
  const line = grammarLine(text);
  return (
    line.length <= SIGNATURE_TITLE_LINE_MAX_CHARS &&
    SIGNATURE_TITLE_RE.test(line)
  );
};

/** A judge's title as a bench signs: `SSO Jan Kowalski`, `SSA del. …`. */
const BENCH_TITLES: ReadonlySet<string> = new Set([
  "SSN",
  "SSA",
  "SSO",
  "SSR",
  "SNSA",
  "SWSA",
]);
const SECONDED_MARK = "del.";
/** Most words one signed name runs to (`Anna Maria Kowalska-Nowak`). */
const SIGNED_NAME_MAX_WORDS = 4;
const NAME_WORD_RE = /^\p{Lu}[\p{L}\p{M}'’.]*(?:-\p{Lu}?[\p{L}\p{M}'’.]*)*$/u;
/** A role beside a signed name: `(spr.)`, `(przewodniczący)`. */
const NAME_NOTE_RE = /^\([^()]*\)$/u;

/**
 * Whether a line is only judges' titles and names, as a bench signs under
 * its ruling: `SSO Katarzyna Banko`, `SSA Ewa Jastrzębska SSA Małgorzata
 * Wołczańska SSO del. Tomasz Tatarczyk`. Read word by word, so a line
 * holding anything else (a ruling naming a judge) is not one.
 */
const isBenchSignatureLine = (line: string): boolean => {
  // The line is read with single spaces, so a hyphen has at most one beside
  // it on each side (`Balion - Hajduk`, `Staniszewska- Perenc`).
  const words = line.replaceAll(/ ?- ?/gu, "-").split(" ");
  let index = 0;
  while (index < words.length) {
    if (!BENCH_TITLES.has(words[index] ?? "")) {
      return false;
    }
    index += 1;
    if (words[index] === SECONDED_MARK) {
      index += 1;
    }
    const nameStart = index;
    while (
      index < words.length &&
      !BENCH_TITLES.has(words[index] ?? "") &&
      NAME_WORD_RE.test(words[index] ?? "")
    ) {
      index += 1;
    }
    const nameWords = index - nameStart;
    if (nameWords === 0 || nameWords > SIGNED_NAME_MAX_WORDS) {
      return false;
    }
    if (NAME_NOTE_RE.test(words[index] ?? "")) {
      index += 1;
    }
  }
  return words.length > 0;
};

/**
 * A signing label with the place for the signature left blank, or nothing
 * after it: `Przewodniczący:…………`, `Skład orzekający Izby:`. A label
 * followed by a name (`Przewodniczący: Anna Kowalska`) names the bench in
 * the head matter and is not one.
 */
const SIGNING_LABEL_RE =
  /^(?:przewodnicząc[ya]|członkowie|członek|sędziowie|skład orzekający(?: izby)?)\s?:?\s?[.…]*$/iu;

/** The place left for a signature: a line of dots alone. */
const SIGNATURE_BLANK_RE = /^[.…]{3,}$/u;

/** Whether a line signs the decision: a bench's names or a signing label. */
export const isPlSignatureLine = (text: string): boolean => {
  const line = grammarLine(text);
  return isBenchSignatureLine(line) || SIGNING_LABEL_RE.test(line);
};

/** Whether a line is the blank a signature is written on. */
export const isPlSignatureBlank = (text: string): boolean =>
  SIGNATURE_BLANK_RE.test(grammarLine(text).replaceAll(" ", ""));
