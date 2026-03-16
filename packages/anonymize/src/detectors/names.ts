import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";

// ── Name corpus ──────────────────────────────────────
// ~600 common first names across Czech, Slovak, German,
// English, French, Polish, Turkish, and international
// (ECHR/legal context). Frozen set for O(1) lookup.

const FIRST_NAMES: ReadonlySet<string> = Object.freeze(
  new Set([
    // ── Czech male (top 100) ────────────────────────
    "Adam",
    "Aleš",
    "Antonín",
    "Arnošt",
    "Bedřich",
    "Blažej",
    "Bohdan",
    "Bohumil",
    "Bořivoj",
    "Bronislav",
    "Břetislav",
    "Ctibor",
    "Čeněk",
    "Čestmír",
    "Dalibor",
    "Daniel",
    "David",
    "Dobromil",
    "Dominik",
    "Dušan",
    "Eduard",
    "Emil",
    "Ervín",
    "Evžen",
    "Filip",
    "Florián",
    "František",
    "Gustav",
    "Hanuš",
    "Hubert",
    "Hynek",
    "Igor",
    "Ilja",
    "Ivan",
    "Ivo",
    "Jáchym",
    "Jakub",
    "Jan",
    "Jaroslav",
    "Jeroným",
    "Jindřich",
    "Jiří",
    "Josef",
    "Kamil",
    "Karel",
    "Karol",
    "Kornel",
    "Kryštof",
    "Květoslav",
    "Ladislav",
    "Leoš",
    "Leopold",
    "Libor",
    "Lubomír",
    "Lukáš",
    "Marek",
    "Martin",
    "Matěj",
    "Michal",
    "Milan",
    "Miloslav",
    "Miroslav",
    "Mojmír",
    "Norbert",
    "Oldřich",
    "Ondřej",
    "Otakar",
    "Patrik",
    "Pavel",
    "Petr",
    "Přemysl",
    "Radek",
    "Radim",
    "Radomír",
    "René",
    "Robert",
    "Roman",
    "Rostislav",
    "Rudolf",
    "Stanislav",
    "Svatopluk",
    "Šimon",
    "Teodor",
    "Tomáš",
    "Václav",
    "Viktor",
    "Vilém",
    "Vít",
    "Vítězslav",
    "Vladimír",
    "Vlastimil",
    "Vojtěch",
    "Vratislav",
    "Zbyněk",
    "Zdeněk",
    "Zikmund",

    // ── Czech female (top 100) ──────────────────────
    "Adéla",
    "Alena",
    "Alžběta",
    "Andrea",
    "Anežka",
    "Anna",
    "Barbora",
    "Bedřiška",
    "Blanka",
    "Blažena",
    "Bohumila",
    "Božena",
    "Cecílie",
    "Dagmar",
    "Dana",
    "Darina",
    "Denisa",
    "Dobromila",
    "Drahomíra",
    "Edita",
    "Eliška",
    "Emilie",
    "Eva",
    "Františka",
    "Gabriela",
    "Gertruda",
    "Hana",
    "Hedvika",
    "Helena",
    "Hermína",
    "Irena",
    "Ivana",
    "Izabela",
    "Jana",
    "Jarmila",
    "Jaroslava",
    "Jiřina",
    "Jitka",
    "Josefa",
    "Karolína",
    "Kateřina",
    "Klára",
    "Kornélie",
    "Kristýna",
    "Květa",
    "Květoslava",
    "Lenka",
    "Leontýna",
    "Libuše",
    "Lucie",
    "Ludmila",
    "Marie",
    "Markéta",
    "Marta",
    "Martina",
    "Michaela",
    "Milada",
    "Milena",
    "Miroslava",
    "Monika",
    "Naděžda",
    "Natálie",
    "Nela",
    "Nikola",
    "Olga",
    "Otýlie",
    "Pavla",
    "Petra",
    "Radka",
    "Radomíra",
    "Renata",
    "Růžena",
    "Simona",
    "Soňa",
    "Stanislava",
    "Svatava",
    "Světlana",
    "Šárka",
    "Tereza",
    "Vendula",
    "Veronika",
    "Věra",
    "Věroslava",
    "Vlasta",
    "Vlastimila",
    "Zdeňka",
    "Zdislava",
    "Zuzana",

    // ── Slovak (top 40) ─────────────────────────────
    "Adrián",
    "Branislav",
    "Daniela",
    "Dáša",
    "Iveta",
    "Ján",
    "Jozef",
    "Katarína",
    "Lucia",
    "Ľudmila",
    "Marián",
    "Maroš",
    "Matúš",
    "Mária",
    "Peter",
    "Radovan",
    "Renáta",
    "Róbert",
    "Silvia",
    "Štefan",
    "Tatiana",
    "Tibor",
    "Viera",
    // (Dušan, Vladimír, Miroslav, Stanislav, Jana,
    //  Eva, Martina, Helena, Monika, Anna, Michal,
    //  Tomáš, Marek, Patrik, Dalibor, Soňa, Zuzana
    //  already listed under Czech)

    // ── German (top 60) ─────────────────────────────
    "Andreas",
    "Angelika",
    "Barbara",
    "Bernd",
    "Bernhard",
    "Birgit",
    "Brigitte",
    "Christa",
    "Claudia",
    "Detlef",
    "Dieter",
    "Elfriede",
    "Erika",
    "Friedrich",
    "Gabriele",
    "Gerhard",
    "Gisela",
    "Günter",
    "Hans",
    "Hartmut",
    "Heike",
    "Heinrich",
    "Helga",
    "Helmut",
    "Herbert",
    "Hildegard",
    "Horst",
    "Ingrid",
    "Julia",
    "Jürgen",
    "Karin",
    "Klaus",
    "Manfred",
    "Matthias",
    "Melanie",
    "Michael",
    "Nicole",
    "Rainer",
    "Renate",
    "Sabine",
    "Sandra",
    "Siegfried",
    "Stefan",
    "Stefanie",
    "Susanne",
    "Thomas",
    "Ulrich",
    "Ursula",
    "Uwe",
    "Volker",
    "Waltraud",
    "Werner",
    "Wolfgang",

    // ── English (top 60) ────────────────────────────
    "Alexander",
    "Alice",
    "Amanda",
    "Andrew",
    "Anne",
    "Anthony",
    "Benjamin",
    "Caroline",
    "Catherine",
    "Charles",
    "Charlotte",
    "Christina",
    "Christopher",
    "Edward",
    "Elizabeth",
    "Emily",
    "Emma",
    "George",
    "Grace",
    "Hannah",
    "Helen",
    "Henry",
    "James",
    "Jane",
    "Jennifer",
    "Jessica",
    "John",
    "Joseph",
    "Laura",
    "Louise",
    "Margaret",
    "Mark",
    "Mary",
    "Matthew",
    "Natalie",
    "Oliver",
    "Olivia",
    "Patrick",
    "Paul",
    "Philip",
    "Rachel",
    "Rebecca",
    "Richard",
    "Roger",
    "Samantha",
    "Sarah",
    "Simon",
    "Sophie",
    "Stephanie",
    "Stephen",
    "Timothy",
    "Victoria",
    "William",
    // (David, Daniel, Thomas, Michael, Peter
    //  already listed above)

    // ── French (top 30) ─────────────────────────────
    "Alain",
    "André",
    "Bernard",
    "Christophe",
    "Christine",
    "Claude",
    "Dominique",
    "François",
    "Françoise",
    "Gérard",
    "Isabelle",
    "Jacques",
    "Jean",
    "Laurent",
    "Michel",
    "Monique",
    "Nathalie",
    "Nicolas",
    "Philippe",
    "Pierre",
    "Stéphane",
    "Sylvie",
    "Sébastien",
    "Thierry",
    "Véronique",
    "Yves",
    // (Marie, Patrick already listed above)

    // ── Turkish (top 20) ────────────────────────────
    "Ahmet",
    "Ayşe",
    "Elif",
    "Emine",
    "Fatma",
    "Hacer",
    "Hatice",
    "Hasan",
    "Hüseyin",
    "Mehmet",
    "Meryem",
    "Nuriye",
    "Osman",
    "Yusuf",
    "Zehra",
    "Zeynep",
    "İbrahim",
    "İsmail",
    // (Ali, Mustafa already listed under International)

    // ── Polish (top 20) ─────────────────────────────
    "Agnieszka",
    "Andrzej",
    "Beata",
    "Dorota",
    "Ewa",
    "Grażyna",
    "Grzegorz",
    "Janusz",
    "Joanna",
    "Katarzyna",
    "Krzysztof",
    "Magdalena",
    "Małgorzata",
    "Marcin",
    "Paweł",
    "Piotr",
    "Tomasz",
    "Wojciech",
    "Zbigniew",
    // (Barbara already listed above)

    // ── International (ECHR/legal context, top 30) ──
    "Ahmed",
    "Ali",
    "Antonio",
    "Carlos",
    "Carmen",
    "Dolores",
    "Fatima",
    "Fernando",
    "Giovanni",
    "Giuseppe",
    "Hassan",
    "Ibrahim",
    "João",
    "Khalid",
    "Luigi",
    "Marco",
    "María",
    "Miguel",
    "Mohammad",
    "Mustafa",
    "Omar",
    "Pablo",
    "Pedro",
    "Pilar",
    "Ricardo",
    "Roberto",
    "Rosa",
    "Sergio",
    "Teresa",
  ]),
);

// ── Common surnames ─────────────────────────────────
// ~200 common Czech/Slovak/German/Austrian surnames.
// Frozen set for O(1) lookup performance.

const COMMON_SURNAMES: ReadonlySet<string> = Object.freeze(
  new Set([
    // ── Czech/Slovak male surnames ──────────────────
    "Bartoš",
    "Beneš",
    "Blaha",
    "Čermák",
    "Černý",
    "Doležal",
    "Duda",
    "Dvořák",
    "Fiala",
    "Hájek",
    "Holub",
    "Horák",
    "Hruška",
    "Jelínek",
    "Kadlec",
    "Kolář",
    "Konečný",
    "Kopecký",
    "Král",
    "Kratochvíl",
    "Krejčí",
    "Kříž",
    "Kubík",
    "Kučera",
    "Malý",
    "Mareš",
    "Mašek",
    "Musil",
    "Navrátil",
    "Nguyen",
    "Novák",
    "Novotný",
    "Němec",
    "Pavlík",
    "Pokorný",
    "Polák",
    "Pospíšil",
    "Procházka",
    "Růžička",
    "Sedláček",
    "Svoboda",
    "Šimek",
    "Šťastný",
    "Tichý",
    "Urban",
    "Vaněk",
    "Veselý",
    "Vlček",
    "Zeman",

    // ── Czech/Slovak female surnames ─────────────────
    "Černá",
    "Dvořáková",
    "Horáková",
    "Kučerová",
    "Němcová",
    "Nováková",
    "Novotná",
    "Procházková",
    "Svobodová",
    "Veselá",

    // ── German/Austrian surnames ─────────────────────
    "Bauer",
    "Becker",
    "Berger",
    "Braun",
    "Brunner",
    "Fischer",
    "Fuchs",
    "Gruber",
    "Hartmann",
    "Hermann",
    "Hofer",
    "Hoffmann",
    "Huber",
    "Kaiser",
    "Koch",
    "Koller",
    "Köhler",
    "Krüger",
    "Lang",
    "Lehmann",
    "Maier",
    "Mayer",
    "Meyer",
    "Moser",
    "Müller",
    "Neumann",
    "Pichler",
    "Richter",
    "Schmidt",
    "Schmid",
    "Schmitt",
    "Schneider",
    "Schröder",
    "Schulz",
    "Schwarz",
    "Steiner",
    "Wagner",
    "Weber",
    "Werner",
    "Winkler",
    "Wolf",
    "Zimmermann",
  ]),
);

// ── Title tokens ─────────────────────────────────────
// Titles that signal a following person name. Lowercased
// for case-insensitive matching.

const TITLE_TOKENS: ReadonlySet<string> = Object.freeze(
  new Set([
    "mr",
    "mrs",
    "ms",
    "miss",
    "dr",
    "prof",
    "doc",
    "ing",
    "mgr",
    "bc",
    "judr",
    "mudr",
    "mvdr",
    "phdr",
    "rndr",
    "paeddr",
    "thdr",
    "sir",
    "dame",
    "lord",
    "lady",
    "judge",
    "justice",
    "maître",
    "mme",
    "mlle",
    "herr",
    "frau",
  ]),
);

// ── False positive guards ────────────────────────────
// Generic roles and legal terms that look like names
// but are not PII. Lowercased for comparison.

const EXCLUDED_WORDS: ReadonlySet<string> = Object.freeze(
  new Set([
    // Legal roles
    "employee",
    "employer",
    "buyer",
    "seller",
    "landlord",
    "tenant",
    "lender",
    "borrower",
    "company",
    "contractor",
    "client",
    "customer",
    "supplier",
    "vendor",
    "party",
    "parties",
    "licensor",
    "licensee",
    "guarantor",
    "applicant",
    "respondent",
    "plaintiff",
    "defendant",
    "claimant",
    "advocate",
    "prosecutor",
    "registrar",
    // Legal/institutional terms
    "court",
    "government",
    "state",
    "republic",
    "parliament",
    "council",
    "assembly",
    "ministry",
    "police",
    "chamber",
    "tribunal",
    "commission",
    "section",
    "division",
    "article",
    "freedom",
    "rector",
    // Common English words that happen to be capitalised
    "the",
    "this",
    "that",
    "with",
    "from",
    "under",
    "over",
    "between",
    "above",
    "below",
    "after",
    "before",
    "during",
    "since",
    "until",
    "upon",
    // Czech roles
    "zaměstnanec",
    "zaměstnavatel",
    "kupující",
    "prodávající",
    "pronajímatel",
    "nájemce",
    "věřitel",
    "dlužník",
    "společnost",
    "zhotovitel",
    "objednatel",
    "strana",
    "strany",
    // German roles
    "arbeitnehmer",
    "arbeitgeber",
    "käufer",
    "verkäufer",
    "vermieter",
    "mieter",
    "darlehensgeber",
    "darlehensnehmer",
    "gesellschaft",
    "auftragnehmer",
    "auftraggeber",
    // Common document words that start with uppercase
    "agreement",
    "contract",
    "schedule",
    "annex",
    "exhibit",
    "appendix",
    "whereas",
    "therefore",
    "provided",
    "including",
    "subject",
    "pursuant",
    "hereby",
    "herein",
    "thereof",
  ]),
);

// ── Czech/Slovak suffix stripping ────────────────────
// Case suffixes commonly appended to names in declined
// Czech/Slovak text. Ordered longest-first.

const INFLECTION_SUFFIXES = [
  "ovi", // dative
  "em", // instrumental
  "om", // instrumental (some stems)
  "ou", // instrumental feminine
  "é", // dative/locative feminine
  "a", // genitive
  "u", // accusative/locative
] as const;

/**
 * Strip common Czech/Slovak case suffixes from a token.
 * Returns the base form if stripping produces a plausible
 * name (capitalised, length >= 3), otherwise null.
 */
const stripInflection = (token: string): string | null => {
  for (const suffix of INFLECTION_SUFFIXES) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      const base = token.slice(0, -suffix.length);
      // Base must start with uppercase
      if (/^\p{Lu}/u.test(base)) {
        return base;
      }
    }
  }
  return null;
};

// ── Token types ──────────────────────────────────────

const TOKEN_TYPE = {
  NAME: "name",
  SURNAME: "surname",
  TITLE: "title",
  ABBREVIATION: "abbreviation",
  CAPITALIZED: "capitalized",
  OTHER: "other",
} as const;

type TokenType = (typeof TOKEN_TYPE)[keyof typeof TOKEN_TYPE];

type ClassifiedToken = {
  text: string;
  type: TokenType;
  start: number;
  end: number;
};

// ── Helpers ──────────────────────────────────────────

const UPPER_START_RE = /^\p{Lu}/u;
const ALL_UPPER_RE = /^\p{Lu}+$/u;

/**
 * Check if a token is in the first-name set, either
 * directly or after stripping Czech/Slovak inflection.
 */
const isFirstNameToken = (token: string): boolean => {
  if (FIRST_NAMES.has(token)) {
    return true;
  }
  const base = stripInflection(token);
  return base !== null && FIRST_NAMES.has(base);
};

/**
 * Check if a token is in the surname set, either
 * directly or after stripping Czech/Slovak inflection.
 */
const isSurnameToken = (token: string): boolean => {
  if (COMMON_SURNAMES.has(token)) {
    return true;
  }
  const base = stripInflection(token);
  return base !== null && COMMON_SURNAMES.has(base);
};

/**
 * Check if a token looks like a single-letter
 * abbreviation: "J.", "M.", etc.
 */
const isAbbreviation = (token: string): boolean =>
  token.length === 2 && /^\p{Lu}$/u.test(token[0] ?? "") && token[1] === ".";

/**
 * Detect whether a position is at the start of a
 * sentence. Looks backward for sentence-ending
 * punctuation followed by whitespace.
 */
const isSentenceStart = (fullText: string, position: number): boolean => {
  if (position === 0) {
    return true;
  }
  // Walk backwards past whitespace
  let i = position - 1;
  while (i >= 0 && /\s/.test(fullText[i] ?? "")) {
    i--;
  }
  if (i < 0) {
    return true;
  }
  const char = fullText[i];
  return char === "." || char === "!" || char === "?";
};

// ── Word segmentation ────────────────────────────────

const segmenter = new Intl.Segmenter(undefined, {
  granularity: "word",
});

type WordSegment = {
  text: string;
  start: number;
  end: number;
};

/**
 * Split text into word segments using Intl.Segmenter.
 * Only returns segments flagged as words.
 */
const segmentWords = (fullText: string): WordSegment[] => {
  const words: WordSegment[] = [];
  for (const seg of segmenter.segment(fullText)) {
    if (seg.isWordLike) {
      words.push({
        text: seg.segment,
        start: seg.index,
        end: seg.index + seg.segment.length,
      });
    }
  }
  return words;
};

// ── Helpers for chain scoring ────────────────────────

/** NAME or SURNAME — both represent corpus-matched tokens */
const isCorpusMatch = (type: TokenType): boolean =>
  type === TOKEN_TYPE.NAME || type === TOKEN_TYPE.SURNAME;

// ── Token classification ─────────────────────────────

const classifyToken = (word: WordSegment): ClassifiedToken => {
  const { text, start, end } = word;
  const lower = text.toLowerCase();

  // Strip trailing period for title check (e.g., "Ing.")
  const stripped = text.endsWith(".") ? text.slice(0, -1).toLowerCase() : lower;

  if (TITLE_TOKENS.has(stripped)) {
    return { text, type: TOKEN_TYPE.TITLE, start, end };
  }

  if (isAbbreviation(text)) {
    return {
      text,
      type: TOKEN_TYPE.ABBREVIATION,
      start,
      end,
    };
  }

  // Skip excluded words
  if (EXCLUDED_WORDS.has(lower)) {
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  // Minimum length 3
  if (text.length < 3) {
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  // Skip all-uppercase tokens > 3 chars (likely acronyms)
  if (text.length > 3 && ALL_UPPER_RE.test(text)) {
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  // Must start with uppercase
  if (!UPPER_START_RE.test(text)) {
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  if (isFirstNameToken(text)) {
    return { text, type: TOKEN_TYPE.NAME, start, end };
  }

  if (isSurnameToken(text)) {
    return { text, type: TOKEN_TYPE.SURNAME, start, end };
  }

  // Capitalised word (not in corpus but starts uppercase)
  return {
    text,
    type: TOKEN_TYPE.CAPITALIZED,
    start,
    end,
  };
};

// ── Chain assembly ───────────────────────────────────

/**
 * Detect person names by looking up tokens against the
 * name corpus, then chaining adjacent name-like tokens.
 *
 * Scoring:
 *   TITLE + NAME/SURNAME       → 0.95
 *   NAME + NAME/SURNAME        → 0.9
 *   SURNAME + NAME/SURNAME     → 0.9
 *   NAME + CAPITALIZED         → 0.7
 *   ABBREVIATION + NAME        → 0.7
 *   Standalone NAME            → 0.5 (low confidence)
 *   Standalone SURNAME         → skip (too ambiguous)
 */
export const detectNameCorpus = (fullText: string): Entity[] => {
  const words = segmentWords(fullText);
  const tokens = words.map((w) => classifyToken(w));
  const entities: Entity[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) {
      continue;
    }

    const token = tokens[i];
    if (!token) {
      continue;
    }

    // Only start chains from TITLE, NAME, SURNAME,
    // or ABBREVIATION
    if (
      token.type !== TOKEN_TYPE.TITLE &&
      token.type !== TOKEN_TYPE.NAME &&
      token.type !== TOKEN_TYPE.SURNAME &&
      token.type !== TOKEN_TYPE.ABBREVIATION
    ) {
      continue;
    }

    // Build a chain of adjacent relevant tokens.
    // Max 5 tokens to prevent merging independent names
    // (e.g., "Jan Novák Pavel Moc" should be two entities).
    const MAX_CHAIN = 5;
    const chain: ClassifiedToken[] = [token];
    let j = i + 1;

    while (j < tokens.length && chain.length < MAX_CHAIN) {
      const next = tokens[j];
      if (!next) {
        break;
      }

      // Break chain if there's a newline between tokens
      const prev = chain.at(-1);
      if (prev) {
        const gap = fullText.slice(prev.end, next.start);
        if (gap.includes("\n")) {
          break;
        }
      }

      // Only chain NAME, SURNAME, TITLE, ABBREVIATION,
      // CAPITALIZED
      if (
        next.type === TOKEN_TYPE.NAME ||
        next.type === TOKEN_TYPE.SURNAME ||
        next.type === TOKEN_TYPE.TITLE ||
        next.type === TOKEN_TYPE.ABBREVIATION ||
        next.type === TOKEN_TYPE.CAPITALIZED
      ) {
        chain.push(next);
        j++;
      } else {
        break;
      }
    }

    // Score the chain
    const hasTitle = chain.some((t) => t.type === TOKEN_TYPE.TITLE);
    const hasCorpusName = chain.some((t) => isCorpusMatch(t.type));
    const hasFirstName = chain.some((t) => t.type === TOKEN_TYPE.NAME);
    const hasAbbreviation = chain.some(
      (t) => t.type === TOKEN_TYPE.ABBREVIATION,
    );
    const corpusCount = chain.filter((t) => isCorpusMatch(t.type)).length;
    const capitalizedCount = chain.filter(
      (t) => t.type === TOKEN_TYPE.CAPITALIZED,
    ).length;

    // Determine score based on chain composition
    let score = 0;

    if (hasTitle && hasCorpusName) {
      // TITLE + NAME/SURNAME → high confidence
      score = 0.95;
    } else if (corpusCount >= 2) {
      // NAME + NAME, NAME + SURNAME, etc. → high confidence
      score = 0.9;
    } else if (hasCorpusName && capitalizedCount > 0) {
      // NAME/SURNAME + CAPITALIZED → medium confidence
      score = 0.7;
    } else if (hasAbbreviation && hasCorpusName) {
      // ABBREVIATION + NAME/SURNAME → medium confidence
      score = 0.7;
    } else if (hasFirstName && chain.length === 1) {
      // Standalone first NAME → low confidence
      // Skip if at sentence start (likely not a name)
      if (isSentenceStart(fullText, token.start)) {
        continue;
      }
      score = 0.5;
    } else if (
      !hasFirstName &&
      chain.length === 1 &&
      chain[0]?.type === TOKEN_TYPE.SURNAME
    ) {
      // Standalone SURNAME → skip (too ambiguous alone)
      continue;
    } else if (hasTitle && chain.length === 1) {
      // Standalone TITLE → skip (not a name by itself)
      continue;
    } else {
      // No corpus match in chain → skip
      if (!hasCorpusName) {
        continue;
      }
      score = 0.5;
    }

    // Build entity span from first to last token in chain
    const first = chain.at(0);
    const last = chain.at(-1);
    if (!first || !last) {
      continue;
    }

    const start = first.start;
    const end = last.end;
    const text = fullText.slice(start, end);

    // Mark all chain tokens as consumed
    for (let k = i; k < i + chain.length; k++) {
      consumed.add(k);
    }

    entities.push({
      start,
      end,
      label: "person",
      text,
      score,
      source: DETECTION_SOURCES.REGEX,
    });
  }

  return entities;
};
