import { panic } from "better-result";

import { foldToAscii, normalizeUnicode } from "@stll/text-normalize";

import {
  type CourtCitationGrammar,
  courtCitationGrammarOf,
  type CourtHead,
  type DirectoryCourt,
} from "./court-citation-directory";

/**
 * How a citation names a court, and which court a decision is stored under,
 * read onto one identity so the two can be compared.
 *
 * Every alias is generated from the court directory and the court-name heads
 * (`court-citation-directory.ts`): the official name, its head declined
 * through the cases a citation writes it in (`Okresního soudu v Benešově`),
 * the short code with the seat in the nominative and after its preposition
 * (`OS Benešov`, `OS v Benešově`), Prague's numbered forms (`OS Praha 6`,
 * `OS P6`, `OS pro Prahu 6`), a regional court's branch and branch seat, and
 * the recorded ECLI court codes (`OSPH06`). A court a decision is stored under
 * that the directory lacks gets the same generated forms from its stored name.
 *
 * An alias that more than one court answers to is never read as one of them:
 * the reading names every court it could be, and the caller treats that as
 * ambiguous.
 */

/** A court a citation can name: the directory's, or a stored name's. */
export type CitedCourt = {
  key: string;
  name: string;
  aliases: readonly string[];
  ecliCodes: readonly string[];
};

export type CourtCitationIndex = {
  country: string;
  courts: ReadonlyMap<string, CitedCourt>;
  /** Folded alias → the courts answering to it. */
  byAlias: ReadonlyMap<string, ReadonlySet<string>>;
  /** Upper-cased ECLI court code → court. */
  byCode: ReadonlyMap<string, string>;
  maxAliasTokens: number;
};

/** One court constraint a citation's words carry. */
export type CourtCitationConstraint =
  /** Courts the words name; more than one is an ambiguous alias. */
  | { type: "court"; courts: readonly [string, ...string[]] }
  /**
   * An ECLI court code, held against the decision's own ECLI; `court` is the
   * directory court recording it, which places a decision without an ECLI.
   */
  | { type: "ecli-code"; code: string; court?: string | undefined }
  /** Words that name a court no alias reads. */
  | { type: "unrecognized" };

const PUNCTUATION_RE = /[.,;:()[\]{}"'„“”‚‘’«»!?]/gu;
const JOINER_RE = /[-‐‑‒–—―/_\\]/gu;
const LETTER_DIGIT_RE = /(\p{L})(\p{N})/gu;
const DIGIT_LETTER_RE = /(\p{N})(\p{L})/gu;

/**
 * The comparison form of court text: case, diacritics, punctuation and dash
 * style carry no meaning in a court's name, and a seat number written onto
 * its letter (`P6`) is the same seat as `P 6`.
 */
export const foldCourtText = (value: string): readonly string[] =>
  foldToAscii(normalizeUnicode(value, "NFKC"))
    .toLowerCase()
    .replace(PUNCTUATION_RE, " ")
    .replace(JOINER_RE, " ")
    .replace(LETTER_DIGIT_RE, "$1 $2")
    .replace(DIGIT_LETTER_RE, "$1 $2")
    .split(/\s+/u)
    .filter((token) => token !== "");

const foldedKey = (value: string): string => foldCourtText(value).join(" ");

/**
 * A country without a declared grammar reads only the names its decisions
 * are stored under, so its citations still constrain by court name.
 */
const STORED_NAMES_ONLY: CourtCitationGrammar = {
  kind: "grammar",
  heads: {},
  apexSuffixes: [""],
  englishSuffixes: [""],
  ecliJurisdiction: null,
  ecliFamilyPrefixes: [],
  courts: [],
};

const grammarFor = (country: string): CourtCitationGrammar =>
  courtCitationGrammarOf(country) ?? STORED_NAMES_ONLY;

const headsOf = (country: string): ReadonlyMap<string, CourtHead> =>
  new Map(Object.entries<CourtHead>(grammarFor(country).heads));

const apexSuffixesOf = (country: string): readonly string[] =>
  grammarFor(country).apexSuffixes;

const englishSuffixesOf = (country: string): readonly string[] =>
  grammarFor(country).englishSuffixes;

const joined = (...parts: readonly string[]): string =>
  parts.filter((part) => part !== "").join(" ");

/** The forms an apex court is cited by: head, code, English, country. */
const apexAliases = (country: string, head: CourtHead): string[] => [
  ...apexSuffixesOf(country).flatMap((suffix) => [
    ...head.forms.map((form) => joined(form, suffix)),
    ...head.codes.map((code) => joined(code, suffix)),
  ]),
  ...(head.english ?? []).flatMap((english) =>
    englishSuffixesOf(country).map((suffix) => joined(english, suffix)),
  ),
];

/** Every spelling of a seat a citation writes after the court's head. */
const seatTexts = (seat: NonNullable<DirectoryCourt["seat"]>): string[] => [
  ...(seat.prepositional === undefined
    ? []
    : [joined(seat.prepositional.preposition, seat.prepositional.form)]),
  seat.nominative,
];

/** The aliases of one directory court. */
export const directoryCourtAliases = (
  country: string,
  court: DirectoryCourt,
): readonly string[] => {
  const head = headsOf(country).get(court.head);
  const aliases: string[] = [court.name, ...(court.extraAliases ?? [])];
  if (head === undefined) {
    return [...new Set(aliases)];
  }
  const { seat, branch, pragueDistrict, seatCode } = court;
  if (seat === undefined) {
    aliases.push(...apexAliases(country, head));
    return [...new Set(aliases)];
  }
  const seats = seatTexts(seat);
  if (pragueDistrict !== undefined) {
    const number = String(pragueDistrict);
    seats.push(`v Praze ${number}`);
    aliases.push(...head.codes.map((code) => `${code} P${number}`));
  }
  const based = [
    ...head.forms.flatMap((form) => seats.map((text) => joined(form, text))),
    ...head.codes.flatMap((code) => seats.map((text) => joined(code, text))),
    ...(seatCode === undefined
      ? []
      : head.codes.map((code) => joined(code, seatCode))),
  ];
  if (branch === undefined) {
    aliases.push(...based);
    return [...new Set(aliases)];
  }
  const branchSeats = seatTexts(branch);
  aliases.push(
    ...based.flatMap((base) =>
      ["pobočka", "pobočky", "pobočce", "pobočkou"].flatMap((noun) =>
        branchSeats.map((text) => joined(base, noun, text)),
      ),
    ),
    // A branch is cited by its own seat as well: `KS Zlín`, `Krajský soud
    // v Olomouci`. No regional court sits in a branch's town.
    ...head.forms.flatMap((form) =>
      branchSeats.map((text) => joined(form, text)),
    ),
    ...head.codes.flatMap((code) =>
      branchSeats.map((text) => joined(code, text)),
    ),
  );
  return [...new Set(aliases)];
};

/**
 * The aliases of a court known only by its stored name: the name, and, where
 * it opens with a known head, the head declined and abbreviated before the
 * rest of the name (`Sąd Okręgowy w Krakowie` → `SO w Krakowie`).
 */
export const storedCourtAliases = (
  country: string,
  name: string,
): readonly string[] => {
  const heads = [...headsOf(country).values()].toSorted(
    (left, right) => right.forms[0].length - left.forms[0].length,
  );
  const lower = name.toLocaleLowerCase("und");
  const head = heads.find(({ forms: [nominative] }) => {
    const opening = nominative.toLocaleLowerCase("und");
    return lower === opening || lower.startsWith(`${opening} `);
  });
  if (head === undefined) {
    return [name];
  }
  const rest = name.slice(head.forms[0].length).trim();
  if (apexSuffixesOf(country).includes(rest)) {
    return [...new Set([name, ...apexAliases(country, head)])];
  }
  return [
    ...new Set([
      name,
      ...head.forms.map((form) => joined(form, rest)),
      ...head.codes.map((code) => joined(code, rest)),
    ]),
  ];
};

type MutableIndex = {
  courts: Map<string, CitedCourt>;
  byAlias: Map<string, Set<string>>;
  byCode: Map<string, string>;
  maxAliasTokens: number;
};

const addCourt = (index: MutableIndex, court: CitedCourt): void => {
  index.courts.set(court.key, court);
  for (const alias of court.aliases) {
    const tokens = foldCourtText(alias);
    if (tokens.length === 0) {
      continue;
    }
    const key = tokens.join(" ");
    const keys = index.byAlias.get(key) ?? new Set<string>();
    keys.add(court.key);
    index.byAlias.set(key, keys);
    index.maxAliasTokens = Math.max(index.maxAliasTokens, tokens.length);
  }
  for (const code of court.ecliCodes) {
    const upper = code.toUpperCase();
    const existing = index.byCode.get(upper);
    if (existing !== undefined && existing !== court.key) {
      panic(`ECLI court code ${upper} is recorded for two courts`);
    }
    index.byCode.set(upper, court.key);
  }
};

const directoryIndexes = new Map<string, MutableIndex>();

const directoryIndex = (country: string): MutableIndex => {
  const cached = directoryIndexes.get(country);
  if (cached !== undefined) {
    return cached;
  }
  const index: MutableIndex = {
    courts: new Map(),
    byAlias: new Map(),
    byCode: new Map(),
    maxAliasTokens: 0,
  };
  const { courts } = grammarFor(country);
  for (const court of courts) {
    addCourt(index, {
      key: `${country}:${court.name}`,
      name: court.name,
      aliases: directoryCourtAliases(country, court),
      ecliCodes: court.ecliCodes,
    });
  }
  directoryIndexes.set(country, index);
  return index;
};

/**
 * The courts a citation in this country can name: the directory's, and
 * every stored court name it does not already read (a court the directory
 * lacks, or a publisher's spelling it cannot place).
 */
export const courtCitationIndex = (
  country: string,
  storedNames: readonly string[] = [],
): CourtCitationIndex => {
  const base = directoryIndex(country);
  const unread = [...new Set(storedNames)].filter((name) => {
    const folded = foldedKey(name);
    return folded !== "" && !base.byAlias.has(folded);
  });
  if (unread.length === 0) {
    return { country, ...base };
  }
  const index: MutableIndex = {
    courts: new Map(base.courts),
    byAlias: new Map(
      [...base.byAlias].map(([alias, keys]) => [alias, new Set(keys)]),
    ),
    byCode: new Map(base.byCode),
    maxAliasTokens: base.maxAliasTokens,
  };
  for (const name of unread) {
    const folded = foldedKey(name);
    if (index.byAlias.has(folded)) {
      continue;
    }
    addCourt(index, {
      key: `${country}:stored:${folded}`,
      name,
      aliases: storedCourtAliases(country, name),
      ecliCodes: [],
    });
  }
  return { country, ...index };
};

const ECLI_COURT_SEGMENT_RE =
  /^ECLI:(?<jurisdiction>[A-Z]{2}):(?<code>[A-Za-z0-9]{1,10}):/u;

/** A decision's ECLI court code, where its ECLI is this country's. */
export const ecliCourtCodeOf = (
  country: string,
  ecli: string | null | undefined,
): string | undefined => {
  const groups =
    ecli === null || ecli === undefined
      ? undefined
      : ECLI_COURT_SEGMENT_RE.exec(ecli.trim().toUpperCase())?.groups;
  const jurisdiction = grammarFor(country).ecliJurisdiction ?? undefined;
  return groups?.["jurisdiction"] === jurisdiction
    ? groups?.["code"]
    : undefined;
};

/**
 * The court a stored decision belongs to, and its ECLI court code. The
 * stored name decides where it reads as one court: a regional court's branch
 * can publish under the main court's code, so the code places a decision
 * only when its name does not.
 */
export const storedCourtIdentity = (
  index: CourtCitationIndex,
  { court, ecli }: { court: string; ecli: string | null },
): { key: string | undefined; code: string | undefined } => {
  const named = index.byAlias.get(foldedKey(court));
  const nameKey = named?.size === 1 ? [...named][0] : undefined;
  const code = ecliCourtCodeOf(index.country, ecli);
  return {
    key: nameKey ?? (code === undefined ? undefined : index.byCode.get(code)),
    code,
  };
};

/** Nouns that name a court, folded. */
const COURT_NOUNS: ReadonlySet<string> = new Set([
  "soud",
  "soudu",
  "soudem",
  "sud",
  "sudu",
  "sude",
  "sudom",
  "sad",
  "sadu",
  "sadem",
  "sadzie",
  "trybunal",
  "trybunalu",
  "court",
  "tribunal",
  "birosag",
  "birosaga",
  "itelotabla",
  "torvenyszek",
  "jarasbirosag",
]);

/** Words that are one court's name on their own, folded. */
const NAMED_COURT_WORDS: ReadonlySet<string> = new Set([
  "kuria",
  "curia",
  "alkotmanybirosag",
]);

/** Hungarian court nouns a seat adjective makes one court, folded. */
const HUNGARIAN_COURT_NOUNS: ReadonlySet<string> = new Set([
  "itelotabla",
  "torvenyszek",
  "jarasbirosag",
  "birosag",
]);

/** Folded stems of the adjectives that make a court noun one court. */
const COURT_MODIFIER_STEMS = [
  "okresn",
  "obvodn",
  "krajsk",
  "mestsk",
  "vrchn",
  "nejvyss",
  "najvyss",
  "spravn",
  "ustavn",
  "specializovan",
  "trestn",
  "okregow",
  "rejonow",
  "apelacyjn",
  "wojewodzk",
  "administracyjn",
  "najwyzsz",
  "konstytucyjn",
  "naczeln",
  "district",
  "regional",
  "municipal",
  "high",
  "supreme",
  "constitutional",
  "administrative",
  "appeal",
  "appellate",
  "city",
  "county",
  "general",
  "fovarosi",
  "legfelsobb",
] as const;

/** Prepositions that seat a court noun: `soud v …`, `court of …`. */
const SEAT_PREPOSITIONS: ReadonlySet<string> = new Set([
  "v",
  "ve",
  "vo",
  "pro",
  "w",
  "we",
  "in",
  "of",
  "for",
  "dla",
]);

/** Short codes a citation writes for a court, as typed. */
const COURT_SHORT_CODES: ReadonlySet<string> = new Set([
  "OS",
  "KS",
  "VS",
  "MS",
  "NS",
  "NSS",
  "ÚS",
  "ObvS",
  "SpS",
  "ŠTS",
  "SN",
  "NSA",
  "TK",
  "WSA",
  "SA",
  "SO",
  "SR",
  "AB",
  "LB",
]);

/** Short codes that are no word in any served language, in any case. */
const CASELESS_SHORT_CODES: ReadonlySet<string> = new Set([
  "os",
  "ks",
  "nss",
  "obvs",
]);

const WORD_CHARACTER_RE = /[\p{L}\p{N}]/u;

/** A word without the punctuation around it (`(OS`, `6),`). */
const bareWord = (word: string): string => {
  const first = word.search(WORD_CHARACTER_RE);
  if (first === -1) {
    return "";
  }
  let end = word.length;
  while (end > first && !WORD_CHARACTER_RE.test(word.slice(end - 1, end))) {
    end -= 1;
  }
  return word.slice(first, end);
};

/**
 * Whether words name a court, read or not: a court noun with a modifier
 * before it or a seat after it (`soud v Neznámově`, `Obvodní soud`), or a
 * court's short code. A court noun on its own (`rozhodnutí soudu`) is the
 * generic word and names none.
 */
type FoldedToken = { token: string; capitalized: boolean };

const namesSomeCourt = (
  folded: readonly FoldedToken[],
  words: readonly string[],
): boolean =>
  folded.some(({ token }, index) => {
    const tokens = folded.map((entry) => entry.token);
    if ([...NAMED_COURT_WORDS].some((word) => token.startsWith(word))) {
      return true;
    }
    const hungarianNoun = [...HUNGARIAN_COURT_NOUNS].some((noun) =>
      token.startsWith(noun),
    );
    if (!COURT_NOUNS.has(token) && !hungarianNoun) {
      return false;
    }
    const before = tokens[index - 1];
    const after = tokens[index + 1];
    const modifies = (word: string | undefined): boolean =>
      word !== undefined &&
      COURT_MODIFIER_STEMS.some((stem) => word.startsWith(stem));
    return (
      // `Krajský soud`, and Polish `Sąd Okręgowy` with the adjective after.
      modifies(before) ||
      modifies(after) ||
      // A Hungarian court opens with its seat's adjective: `Debreceni
      // Ítélőtábla`.
      (hungarianNoun && before?.endsWith("i") === true) ||
      // A seat names a place, so it is capitalized: `soud v Neznámově`,
      // not `soudu ve správním řízení`.
      (after !== undefined &&
        SEAT_PREPOSITIONS.has(after) &&
        (folded[index + 2]?.capitalized === true ||
          modifies(tokens[index + 2])))
    );
  }) ||
  words.some(
    (word) =>
      COURT_SHORT_CODES.has(word) ||
      CASELESS_SHORT_CODES.has(word.toLowerCase()),
  );

const UNKNOWN_CODE_TAIL_RE = /^[A-Z]{2,4}\d{0,2}$/u;

/** A word shaped like an ECLI court code of the country's families. */
const familyCodeOf = (country: string, word: string): string | undefined => {
  const upper = word.toUpperCase();
  // Typed in upper case, or numbered so it is no word (`osph99`).
  if (word !== upper && !/\p{N}/u.test(word)) {
    return undefined;
  }
  const prefix = grammarFor(country)
    .ecliFamilyPrefixes.map((candidate) => candidate.toUpperCase())
    .find((candidate) => upper.startsWith(candidate));
  return prefix !== undefined &&
    UNKNOWN_CODE_TAIL_RE.test(upper.slice(prefix.length))
    ? upper
    : undefined;
};

/** A bare short code no longer than this is read only as typed in capitals. */
const BARE_CODE_MAX_LETTERS = 3;

type Match = { start: number; end: number; keys: ReadonlySet<string> };

/**
 * The court constraints in a citation's words outside its reference. Every
 * alias the words carry is one constraint; words naming a court no alias
 * reads are one more, unreadable, constraint. Words that name no court give
 * none.
 */
export const readCourtCitation = (
  index: CourtCitationIndex,
  text: string,
): readonly CourtCitationConstraint[] => {
  const constraints: CourtCitationConstraint[] = [];
  const words = text
    .split(/\s+/u)
    .map(bareWord)
    .filter((word) => word !== "");
  const tokens: {
    token: string;
    word: number;
    capitalized: boolean;
    upper: boolean;
  }[] = [];
  for (const [wordIndex, word] of words.entries()) {
    const upper = word.toUpperCase();
    // A word that is itself an alias (`NS`, `ÚS`) is read with the words
    // around it (`NS ČR`), not as a lone code.
    const coded =
      upper.length >= 2 && !index.byAlias.has(foldedKey(word))
        ? index.byCode.get(upper)
        : undefined;
    // A recorded code typed in upper case, or long or numbered enough to be
    // no word (`osph06`), names its court by code.
    if (
      coded !== undefined &&
      (word === upper || upper.length >= 4 || /\p{N}/u.test(word))
    ) {
      constraints.push({ type: "ecli-code", code: upper, court: coded });
      continue;
    }
    const familyCode = familyCodeOf(index.country, word);
    if (familyCode !== undefined && familyCode.length >= 4) {
      constraints.push({ type: "ecli-code", code: familyCode });
      continue;
    }
    for (const token of foldCourtText(word)) {
      tokens.push({
        token,
        word: wordIndex,
        capitalized: /^\p{Lu}/u.test(word),
        upper: word === word.toUpperCase(),
      });
    }
  }
  const matches: Match[] = [];
  for (let start = 0; start < tokens.length; start += 1) {
    const longest = Math.min(tokens.length, start + index.maxAliasTokens);
    for (let end = start + 1; end <= longest; end += 1) {
      const phrase = tokens
        .slice(start, end)
        .map(({ token }) => token)
        .join(" ");
      const keys = index.byAlias.get(phrase);
      // A lone short code in lower case is a word (`show us`), not `ÚS`.
      const lowerBareCode =
        end - start === 1 &&
        phrase.length <= BARE_CODE_MAX_LETTERS &&
        tokens[start]?.upper !== true;
      if (keys !== undefined && !lowerBareCode) {
        matches.push({ start, end, keys });
      }
    }
  }
  const maximal = matches.filter(
    (match) =>
      !matches.some(
        (other) =>
          other !== match &&
          other.start <= match.start &&
          other.end >= match.end &&
          other.end - other.start > match.end - match.start,
      ),
  );
  for (const { keys } of maximal) {
    const [first, ...rest] = [...keys].toSorted();
    if (first !== undefined) {
      constraints.push({ type: "court", courts: [first, ...rest] });
    }
  }
  const covered = (position: number): boolean =>
    maximal.some(({ start, end }) => start <= position && position < end);
  const leftover = tokens.filter((_, position) => !covered(position));
  const leftoverWords = [...new Set(leftover.map(({ word }) => word))].flatMap(
    (wordIndex) =>
      tokens.every(
        (token, position) => token.word !== wordIndex || !covered(position),
      )
        ? [words[wordIndex] ?? ""]
        : [],
  );
  if (
    namesSomeCourt(
      leftover.map(({ token, capitalized }) => ({ token, capitalized })),
      leftoverWords,
    )
  ) {
    constraints.push({ type: "unrecognized" });
  }
  const seen = new Set<string>();
  return constraints.filter((constraint) => {
    const key = JSON.stringify(constraint);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};
