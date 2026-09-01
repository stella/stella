/**
 * Jurisdiction-conventional citation of one decision, for the reader's
 * legal copy modes. The convention follows the COURT's jurisdiction, never
 * the UI language: a Czech decision is cited in Czech form everywhere.
 *
 * v1 limits, deliberate: pincites are emitted only where the convention
 * uses reporter pages (USA); paragraph-number pincites (EU, CZ "bod N")
 * need the block's ¶ number threaded through and come later. Czech and
 * Slovak court names are inflected to the genitive by a suffix rule that
 * covers the standing court names; an unrecognized name passes through
 * unchanged rather than guessing.
 */

export type CitationInput = {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: Date | string | null;
  decisionType: string | null;
  ecli: string | null;
  /** Citable case name where the tradition uses one (USA, EU). */
  name: string | null;
  /** Reporter page the quotation starts on (USA convention only). */
  pincite: string | null;
};

const DATE_ONLY_RE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/u;

const dateOf = (value: Date | string | null): Date | null => {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    // A date-only string parsed by `new Date` lands on midnight UTC, which
    // is the previous day in west-of-UTC zones; build it in local time so
    // the printed day, month and year match the document.
    const parts = DATE_ONLY_RE.exec(value)?.groups;
    if (parts?.["year"] !== undefined) {
      return new Date(
        Number(parts["year"]),
        Number(parts["month"]) - 1,
        Number(parts["day"]),
      );
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** "17. 5. 1954" — Czech and Slovak legal writing. */
const dottedDate = (date: Date): string =>
  `${String(date.getDate())}. ${String(date.getMonth() + 1)}. ${String(date.getFullYear())}`;

/**
 * Czech/Slovak genitive of a court name: leading adjectives take the
 * genitive ending and the head noun "soud"/"súd" becomes "soudu"/"súdu";
 * everything after the head noun (e.g. "v Praze") is already invariant.
 */
const COURT_GENITIVE_SUFFIXES: readonly (readonly [string, string])[] = [
  ["ší", "šího"],
  ["ný", "ného"],
  ["ní", "ního"],
  ["ký", "kého"],
  ["ší", "šieho"],
];

const genitiveCourt = (court: string, language: "cs" | "sk"): string => {
  const words = court.split(" ");
  const headIndex = words.findIndex(
    (word) => word === "soud" || word === "súd",
  );
  if (headIndex === -1) {
    return court;
  }
  const inflected = words.map((word, index) => {
    if (index === headIndex) {
      return word === "soud" ? "soudu" : "súdu";
    }
    if (index > headIndex) {
      return word;
    }
    if (language === "sk") {
      if (word.endsWith("ší")) {
        return `${word.slice(0, -2)}šieho`;
      }
      if (word.endsWith("ý")) {
        return `${word.slice(0, -1)}ého`;
      }
      return word;
    }
    for (const [suffix, replacement] of COURT_GENITIVE_SUFFIXES) {
      if (word.endsWith(suffix)) {
        return `${word.slice(0, -suffix.length)}${replacement}`;
      }
    }
    return word;
  });
  return inflected.join(" ");
};

const czechCitation = (input: CitationInput): string => {
  const type = input.decisionType ?? "rozhodnutí";
  const court = genitiveCourt(input.court, "cs");
  const date = dateOf(input.decisionDate);
  const dated = date === null ? "" : ` ze dne ${dottedDate(date)}`;
  return `${type} ${court}${dated}, sp. zn. ${input.caseNumber}`;
};

const slovakCitation = (input: CitationInput): string => {
  const type = input.decisionType ?? "rozhodnutie";
  const court = genitiveCourt(input.court, "sk");
  const date = dateOf(input.decisionDate);
  const dated = date === null ? "" : ` zo dňa ${dottedDate(date)}`;
  return `${type} ${court}${dated}, sp. zn. ${input.caseNumber}`;
};

/**
 * Polish month names in the genitive, as a date inside a citation reads
 * ("z dnia 17 maja 1954 r."). A fixed table, not a locale formatter: the
 * convention belongs to the court, not to the reader's locale settings.
 */
const POLISH_GENITIVE_MONTHS = [
  "stycznia",
  "lutego",
  "marca",
  "kwietnia",
  "maja",
  "czerwca",
  "lipca",
  "sierpnia",
  "września",
  "października",
  "listopada",
  "grudnia",
] as const;

/**
 * Polish genitive of a court name: the head noun and its adjectives inflect
 * ("Sąd Apelacyjny w Łodzi" → "Sądu Apelacyjnego w Łodzi"), while the
 * locality after a preposition stays. All-or-nothing: if any word before
 * the preposition falls outside the known patterns, the nominative passes
 * through unchanged rather than half-inflected.
 */
const POLISH_PREPOSITIONS = new Set(["w", "we", "dla"]);

const polishGenitiveWord = (word: string): string | null => {
  if (word === "Sąd") {
    return "Sądu";
  }
  if (word === "Trybunał") {
    return "Trybunału";
  }
  if (word.endsWith("ni") || word.endsWith("ki")) {
    return `${word.slice(0, -1)}iego`;
  }
  if (word.endsWith("y")) {
    return `${word.slice(0, -1)}ego`;
  }
  return null;
};

const polishGenitiveCourt = (court: string): string => {
  const words = court.split(" ");
  const inflected: string[] = [];
  for (const [index, word] of words.entries()) {
    if (POLISH_PREPOSITIONS.has(word)) {
      inflected.push(...words.slice(index));
      return inflected.join(" ");
    }
    const genitive = polishGenitiveWord(word);
    if (genitive === null) {
      return court;
    }
    inflected.push(genitive);
  }
  return inflected.join(" ");
};

const polishCitation = (input: CitationInput): string => {
  const type = input.decisionType ?? "orzeczenie";
  const date = dateOf(input.decisionDate);
  const month = date === null ? null : POLISH_GENITIVE_MONTHS[date.getMonth()];
  const dated =
    date === null || month === undefined || month === null
      ? ""
      : ` z dnia ${String(date.getDate())} ${month} ${String(date.getFullYear())} r.`;
  return `${type} ${polishGenitiveCourt(input.court)}${dated}, sygn. akt ${input.caseNumber}`;
};

const austrianCitation = (input: CitationInput): string => {
  const date = dateOf(input.decisionDate);
  const dated =
    date === null
      ? ""
      : ` ${String(date.getDate())}. ${String(date.getMonth() + 1)}. ${String(date.getFullYear())},`;
  return `${input.court}${dated} ${input.caseNumber}`;
};

const euCitation = (input: CitationInput): string => {
  const named = input.name === null ? "" : `${input.name}, `;
  const ecli = input.ecli === null ? "" : `, ${input.ecli}`;
  return `${named}${input.caseNumber}${ecli}`;
};

const usCitation = (input: CitationInput): string => {
  const cite =
    input.pincite === null
      ? input.caseNumber
      : `${input.caseNumber}, ${input.pincite}`;
  const named = input.name === null ? cite : `${input.name}, ${cite}`;
  const date = dateOf(input.decisionDate);
  return date === null ? named : `${named} (${String(date.getFullYear())})`;
};

const genericCitation = (input: CitationInput): string => {
  const named = input.name === null ? "" : `${input.name}, `;
  const date = dateOf(input.decisionDate);
  const dated = date === null ? "" : ` (${String(date.getFullYear())})`;
  return `${named}${input.court}, ${input.caseNumber}${dated}`;
};

const CITATION_FORMATTERS: Record<string, (input: CitationInput) => string> = {
  AUT: austrianCitation,
  CZE: czechCitation,
  EU: euCitation,
  POL: polishCitation,
  SVK: slovakCitation,
  USA: usCitation,
};

export const formatDecisionCitation = (input: CitationInput): string =>
  (CITATION_FORMATTERS[input.country] ?? genericCitation)(input);
