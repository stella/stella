// parser-output-unchanged: native NFC normalization retains the same code points and operation order.
import { panic } from "better-result";

import { DANGEROUS_CHARS } from "@stll/legal-ast/text-sanitize";
import { normalizeUnicode } from "@stll/text-normalize";

export const COURTLISTENER_TEXT_USABILITY = {
  USABLE: "usable",
  SOURCE_PLACEHOLDER: "source-placeholder",
  NO_RULING_TEXT: "no-ruling-text",
  UNDECODABLE: "undecodable",
} as const;

export type CourtListenerTextUsability =
  (typeof COURTLISTENER_TEXT_USABILITY)[keyof typeof COURTLISTENER_TEXT_USABILITY];

type PublisherSlot = { type: "opinion-id" | "court" | "filename" };
const OPINION_ID = { type: "opinion-id" } as const;
const PUBLISHER_COURT = { type: "court" } as const;
const PUBLISHER_FILENAME = { type: "filename" } as const;

// Replacement wording is closed; publisher identifiers occupy bounded slots.
const SOURCE_PLACEHOLDER_MESSAGES = [
  ["decision removed at the request of the court."],
  ["entry removed as entered in error"],
  ["failed to extract text."],
  ["file unavailable"],
  ["memorandum decisions"],
  ["memorandum decisions."],
  ["no opinion found. click here to view source material."],
  ["no opinion found.click here to view source material."],
  ["opinion", OPINION_ID, "was never issued or was withdrawn."],
  ["opinion", OPINION_ID, "was never issued."],
  ["opinion", OPINION_ID, "was never released."],
  ["opinion", OPINION_ID, "was never issued oh was withdrawn."],
  ["opinion x", OPINION_ID, "was never issued."],
  ["test document"],
  ["test pdf"],
  ["testing document"],
  ...["opinion", "no.", "case"].flatMap((label) => [
    ["this opinion has been withdrawn.", label, OPINION_ID],
    ["this opinion was never issued.", label, OPINION_ID, "'"],
    ["this opinion was withdrawn.", label, OPINION_ID],
  ]),
  ["unable to extract document content"],
  ["unavailable"],
  [PUBLISHER_COURT, "opinion can't open", PUBLISHER_FILENAME],
] as const satisfies readonly (readonly (string | PublisherSlot)[])[];

const normalizeSourcePlaceholder = (text: string): string =>
  normalizeUnicode(text, "NFC").replace(/\s+/gu, " ").trim().toLowerCase();
const SOURCE_PLACEHOLDER_WORD_SEQUENCES = SOURCE_PLACEHOLDER_MESSAGES.map(
  (message) => {
    const tokens: (string | PublisherSlot)[] = [];
    for (const part of message) {
      if (typeof part === "string") {
        tokens.push(...part.split(" "));
      } else {
        tokens.push(part);
      }
    }
    return tokens;
  },
);

const matchesPublisherSlot = (slot: PublisherSlot, text: string): boolean => {
  switch (slot.type) {
    case "opinion-id":
      return /^#?[a-z]{0,4}[-–]?\d{1,7}(?:-\d{1,4})?$/u.test(text);
    case "court":
      return /^usca(?:[1-9]|1[0-3])$/u.test(text);
    case "filename":
      return /^\d{2}-\d{4}(?:[ep]\d?\.\d{2}[a-z]?|[a-z]\.pdf)\.?$/u.test(text);
    default: {
      slot.type satisfies never;
      return panic("Unhandled publisher identifier slot");
    }
  }
};

const publisherMessageEnds = (words: string[], start: number): number[] => {
  const ends: number[] = [];
  for (const message of SOURCE_PLACEHOLDER_WORD_SEQUENCES) {
    let positions = [start];
    for (const part of message) {
      const next: number[] = [];
      for (const position of positions) {
        if (typeof part === "string") {
          if (words[position] === part) {
            next.push(position + 1);
          }
          continue;
        }
        const maxWords = part.type === "opinion-id" ? 3 : 1;
        for (
          let count = 1;
          count <= maxWords && position + count <= words.length;
          count += 1
        ) {
          if (
            matchesPublisherSlot(
              part,
              words.slice(position, position + count).join(""),
            )
          ) {
            next.push(position + count);
          }
        }
      }
      positions = next;
      if (positions.length === 0) {
        break;
      }
    }
    ends.push(...positions);
  }
  return ends;
};

const isSourcePlaceholder = (text: string): boolean => {
  const normalized = normalizeSourcePlaceholder(text);
  if (!normalized) {
    return false;
  }
  const words = normalized.split(" ");
  return publisherMessageEnds(words, 0).includes(words.length);
};

// Every token must belong to a complete closed message; bounded identifier
// slots may wrap, but unknown tokens always remain candidate ruling text.
const isSourcePlaceholderSequence = (text: string): boolean => {
  const normalized = normalizeSourcePlaceholder(text);
  if (!normalized) {
    return false;
  }
  const words = normalized.split(" ");
  const matches = new Uint8Array(words.length + 1);
  matches[0] = 1;
  for (let start = 0; start < words.length; start += 1) {
    if (matches[start] === 0) {
      continue;
    }
    for (const end of publisherMessageEnds(words, start)) {
      matches[end] = 1;
    }
  }
  return matches[words.length] === 1;
};

const MONTH =
  "(?:january|february|march|april|may|june|july|august|september|october|november|december)";
const WRITTEN_DATE = new RegExp(
  `\\b(?:${MONTH}\\s+\\d{1,2},?\\s+\\d{2,4}|\\d{1,2}\\s+${MONTH}\\s+\\d{2,4})\\b`,
  "gu",
);
const DATE_ONLY = new RegExp(`^${MONTH}\\d{1,2},?\\d{4}$`, "u");

const PERSON_NAME_MAX_TOKENS = 6;
const PERSON_NAME_PARTICLES = new Set(["de", "van", "von", "del", "la", "le"]);
const PERSON_NAME_SUFFIXES = new Set(["Jr.", "Sr.", "II", "III"]);
const PERSON_WORD = /^\p{Lu}[\p{L}\p{M}]*(?:['’-][\p{L}\p{M}]+)*$/u;
const PERSON_INITIAL = /^\p{Lu}\.$/u;

const isPersonName = (text: string): boolean => {
  const tokens = text.split(" ");
  if (tokens.length === 0 || tokens.length > PERSON_NAME_MAX_TOKENS) {
    return false;
  }
  // A disposition also fitting the name slot is ruling text, not attribution.
  if (
    RULING_WORDS.test(text.toLowerCase()) ||
    tokens.some((token) => RULING_WORDS.test(token.toLowerCase()))
  ) {
    return false;
  }
  return (
    tokens.some(
      (token) => PERSON_WORD.test(token) || PERSON_INITIAL.test(token),
    ) &&
    tokens.every((token, index) => {
      if (PERSON_NAME_SUFFIXES.has(token)) {
        return index === tokens.length - 1 && index > 0;
      }
      return (
        PERSON_WORD.test(token) ||
        PERSON_INITIAL.test(token) ||
        (PERSON_NAME_PARTICLES.has(token) && index < tokens.length - 1)
      );
    })
  );
};

type NamedMetadataProduction = {
  prefix: readonly string[];
  suffix: readonly string[];
  nameEnding: "word" | "sentence";
};
const NAMED_METADATA_PRODUCTIONS = [
  {
    prefix: ["mr.", "justice"],
    suffix: ["delivered", "the", "opinion", "of", "the", "court"],
    nameEnding: "word",
  },
  {
    prefix: ["justice"],
    suffix: ["delivered", "the", "opinion", "of", "the", "court"],
    nameEnding: "word",
  },
  {
    prefix: ["opinion", "by", "justice"],
    suffix: ["not", "to", "be", "published", "in", "full"],
    nameEnding: "sentence",
  },
  { prefix: ["judge"], suffix: ["took", "no", "part"], nameEnding: "word" },
] as const satisfies readonly NamedMetadataProduction[];

const matchesNamedProduction = (
  tokens: string[],
  production: NamedMetadataProduction,
): boolean => {
  const nameEnd = tokens.length - production.suffix.length;
  if (
    nameEnd <= production.prefix.length ||
    nameEnd - production.prefix.length > PERSON_NAME_MAX_TOKENS ||
    !production.prefix.every(
      (word, index) => tokens[index]?.toLowerCase() === word,
    ) ||
    !production.suffix.every((word, index) => {
      const token = tokens[nameEnd + index]?.toLowerCase();
      return index === production.suffix.length - 1
        ? token?.replace(/[.!]$/u, "") === word
        : token === word;
    })
  ) {
    return false;
  }
  const name = tokens.slice(production.prefix.length, nameEnd).join(" ");
  if (production.nameEnding === "word") {
    return isPersonName(name);
  }
  // The publication sentence ends the name with a period; an initial or
  // suffix can supply that same period without accepting other punctuation.
  return (
    name.endsWith(".") &&
    (isPersonName(name) || isPersonName(name.slice(0, -1)))
  );
};

// Titles and list punctuation belong to the production, never to a name slot.
const isAttribution = (text: string): boolean => {
  const nameStart = text.toLowerCase().startsWith("opinion by ")
    ? "opinion by ".length
    : 0;
  const comma = text.indexOf(",", nameStart);
  if (comma === -1 || !isPersonName(text.slice(nameStart, comma))) {
    return false;
  }
  return /^(?:(?:[cp] ?\. ?)?j ?\.|c ?\. ?j ?\.|(?:bankruptcy )?judge)(?: ?[:.]| )?$/u.test(
    text
      .slice(comma + 1)
      .trim()
      .toLowerCase(),
  );
};
const isSignature = (text: string): boolean =>
  text.toLowerCase().startsWith("/s/") && isPersonName(text.slice(3).trim());

const isPresentJudgeList = (text: string): boolean => {
  const prefix = /^present\s*[—:-]\s*/iu.exec(text);
  if (!prefix) {
    return false;
  }
  const list = text.slice(prefix[0].length);
  const ending = /,? (?:jj|j)\.[.!]?$/iu.exec(list);
  if (!ending) {
    return false;
  }
  const names = list
    .slice(0, ending.index)
    .split(",")
    .flatMap((part) => part.trim().split(/ and /iu));
  let people = 0;
  for (const name of names) {
    if (/^(?:[pc]\.\s*j\.)$/iu.test(name)) {
      if (people === 0) {
        return false;
      }
      continue;
    }
    if (!isPersonName(name)) {
      return false;
    }
    people += 1;
  }
  return people > 0;
};

const isNamedMetadata = (text: string): boolean =>
  isAttribution(text) ||
  isSignature(text) ||
  isPresentJudgeList(text) ||
  NAMED_METADATA_PRODUCTIONS.some((production) =>
    matchesNamedProduction(text.split(" "), production),
  );

const COURT_HEADER =
  /^(?:in\s+the\s+)?\p{L}+(?:\s+\p{L}+){0,3}\s+court\s+of\s+appeals\s+for\s+the\s+\p{L}+(?:\s+\p{L}+){0,8}\s+circuit[.!]?$/u;
const FILING_HEADER =
  /^case\s*(?::\s*)?[\w:.-]+(?:\s+document\s+\d+)?(?:\s+date)?\s+filed\s*(?::\s*)?\d[\d/.-]*\s+page\s*(?::\s*)?\d+\s+of\s+\d+$/u;
const OFFICE_HEADER =
  /^[^\p{L}]{0,64}office\s+of\s+(?:the\s+)?[\p{L}'’]+(?:\s+general)?(?:\s+of\s+\p{L}+)?[^\p{L}'’]{0,64}$/u;
const DAMAGED_OFFICE_HEADER =
  /^(?:office of\b|[\p{L}'’]+\s+[\p{L}'’[\]]+ general\b)[\s\S]{0,100}$/u;
const COURT_IDENTIFIER =
  /^\d{4}\s+[a-z]{2,4}\s+(?:super|app|sup)\s+\d+[a-z]?(?:\s+[\da-z]+)?$/u;
// Preserve very short dispositions; readable sentences do not need these words.
const RULING_WORDS =
  /^[\s[(]*(?:affirm(?:ed)?|den(?:y|ied)|grant(?:ed)?|dismiss(?:ed)?|revers(?:e|ed)|remand(?:ed)?|ordered|per\s+curiam|acquitted|convicted|sustained|allowed)[\s.!\])]*$/u;

const METADATA_PATTERNS = [
  COURT_HEADER,
  FILING_HEADER,
  OFFICE_HEADER,
  COURT_IDENTIFIER,
  DATE_ONLY,
] as const;

// The OCR-date grammar keeps its existing whitespace-insensitive behavior.
const isMetadata = (text: string): boolean => {
  if (isNamedMetadata(text)) {
    return true;
  }
  const folded = text.toLowerCase();
  return METADATA_PATTERNS.some((pattern) =>
    pattern === DATE_ONLY
      ? pattern.test(folded.replace(/\s+/gu, ""))
      : pattern.test(folded),
  );
};

type NonRulingBlock = "metadata" | "placeholder";

const nonRulingBlock = (block: string): NonRulingBlock | null => {
  const compact = block.replace(/\s+/gu, " ").trim();
  if (isSourcePlaceholderSequence(compact)) {
    return "placeholder";
  }
  if (isMetadata(compact)) {
    return "metadata";
  }
  const lines = block
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0);
  let kind: NonRulingBlock = "metadata";
  for (const line of lines) {
    if (isSourcePlaceholder(line)) {
      kind = "placeholder";
      continue;
    }
    if (!isMetadata(line)) {
      return null;
    }
  }
  return lines.length > 0 ? kind : null;
};

const hasReadableSentence = (text: string): boolean => {
  const compactBody = normalizeUnicode(text, "NFC")
    .replace(/\s+/gu, " ")
    .trim();
  if (isSourcePlaceholderSequence(compactBody)) {
    return false;
  }
  for (const paragraph of text.split(/\n[^\S\n]*\n/gu)) {
    const compact = paragraph.replace(/\s+/gu, " ").trim();
    if (isMetadata(compact)) {
      continue;
    }
    // Inspect each sentence separately so a damaged header cannot outweigh an
    // intact sentence, and a publisher message cannot supply its word tokens.
    // Sticky matching prevents retrying an unterminated tail at every character.
    for (const [sentence] of compact.matchAll(/[^.!?。！？]*[.!?。！？]+/guy)) {
      const candidate = sentence.trim();
      if (
        isSourcePlaceholderSequence(candidate) ||
        isMetadata(candidate) ||
        /^(?:click here to view source material|not to be published in full)[.!]?$/u.test(
          candidate,
        )
      ) {
        continue;
      }
      const tokens = Array.from(
        candidate.matchAll(/\S+/gu),
        ([match]) => match,
      );
      const words = tokens.filter((token) =>
        /^["“”'‘’([{]*\p{L}+(?:['’−-]\p{L}+)*[,;:!?。.！？」\])}"“”'‘’]*$/u.test(
          token,
        ),
      );
      const letters = candidate.match(/\p{L}/gu)?.length ?? 0;
      const nonLetters = candidate.match(/[^\p{L}\s]/gu)?.length ?? 0;
      if (
        words.length >= 3 &&
        words.filter((word) => /\p{L}{2}/u.test(word)).length >= 2 &&
        words.length * 4 >= tokens.length * 3 &&
        letters > nonLetters * 2
      ) {
        return true;
      }
    }
  }
  return false;
};

const isAsciiPunctuationOnly = (text: string): boolean =>
  /^[\s\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]*$/u.test(text);

const isOcrDateFragment = (text: string): boolean =>
  /^\d{2}s\d{1,2}s\d{4}$/u.test(text.replace(/\s+/gu, ""));

const classifyRulingText = (rulingText: string): CourtListenerTextUsability => {
  // Metadata and replacement messages cannot supply words to damaged ruling text.
  const compact = rulingText.replace(/\s+/gu, " ").trim();
  if (hasReadableSentence(rulingText)) {
    return COURTLISTENER_TEXT_USABILITY.USABLE;
  }
  if (rulingText.split(/\n/gu).some((line) => RULING_WORDS.test(line))) {
    return COURTLISTENER_TEXT_USABILITY.USABLE;
  }

  const remaining = rulingText
    .replace(WRITTEN_DATE, " ")
    // A suffix cannot consume the letter opening the next exemption code.
    .replace(/\([a-z]\)\s*\(\d+\)(?:\s*\([a-z]\)(?!\s*\(\d+\)))?/gu, " ")
    .replace(/\bappendix\s+\d+\b/gu, " ")
    .replace(/\b\d[\d/.,: -]*\b/gu, " ")
    .replace(/\b(?:for|at|of|the|and|to|in|on)\b/gu, " ")
    .trim();
  if (
    /^(?:(?:amended\s+)?memorandum opinion|decision)[\s.!]*$/u.test(remaining)
  ) {
    return COURTLISTENER_TEXT_USABILITY.NO_RULING_TEXT;
  }
  if (!/\p{L}/u.test(remaining)) {
    return /\d/u.test(rulingText) || !remaining
      ? COURTLISTENER_TEXT_USABILITY.NO_RULING_TEXT
      : COURTLISTENER_TEXT_USABILITY.UNDECODABLE;
  }
  // UTF-16 decoded as a single-byte encoding and replacement/control bytes
  // cannot supply a word. A genuine word elsewhere still remains admissible.
  const readable = remaining
    .replace(/(?:ÿþ|þÿ)[\p{L}\p{N}]*/gu, " ")
    .replace(DANGEROUS_CHARS, " ")
    .replace(/\ufffd/gu, " ");
  const letters = readable.match(/\p{L}/gu)?.length ?? 0;
  const punctuation = readable.match(/[^\p{L}\p{N}\s]/gu)?.length ?? 0;
  const damagedWord = /\p{L}[~+?![]\p{L}|\p{L}~~\p{L}/u.test(readable);
  // Consume each alphanumeric run once; testing a trailing digit must not
  // backtrack through a long letter run looking for another word boundary.
  const intactWords = Array.from(
    readable.matchAll(/[\p{L}\p{N}]+/gu),
    ([match]) => match,
  ).filter((word) => /^\p{L}+$/u.test(word));
  const tokens = Array.from(readable.matchAll(/\S+/gu), ([match]) => match);
  const damagedTokens = tokens.filter((token) =>
    /\p{L}[~+?![]\p{L}|\p{L}~~\p{L}/u.test(token),
  );
  if (
    (punctuation > letters * 2 &&
      !intactWords.some((word) => word.length >= 3)) ||
    (damagedWord && !intactWords.some((word) => word.length >= 5)) ||
    (/\p{L}\d/u.test(readable) &&
      !intactWords.some((word) => word.length >= 2)) ||
    (damagedTokens.length * 2 >= tokens.length &&
      damagedTokens.length > 0 &&
      !intactWords.some((word) => word.length >= 6)) ||
    (DAMAGED_OFFICE_HEADER.test(compact) &&
      /general[^\S\r\n]*\n/u.test(rulingText) &&
      /[!?[]\p{L}/u.test(compact))
  ) {
    return COURTLISTENER_TEXT_USABILITY.UNDECODABLE;
  }
  return /\p{L}{2}/u.test(readable)
    ? COURTLISTENER_TEXT_USABILITY.USABLE
    : COURTLISTENER_TEXT_USABILITY.UNDECODABLE;
};

const classifyBody = (unattributed: string): CourtListenerTextUsability => {
  const blocks = unattributed
    .split(/\n[^\S\n]*\n/gu)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  if (
    blocks.some((block) =>
      RULING_WORDS.test(block.replace(/\s+/gu, " ").trim().toLowerCase()),
    )
  ) {
    return COURTLISTENER_TEXT_USABILITY.USABLE;
  }
  const blockKinds = blocks.map(nonRulingBlock);
  const metadataBlocks = new Set(
    blockKinds.flatMap((kind, index) => (kind === "metadata" ? [index] : [])),
  );
  const remainder = blocks.flatMap((block, index) =>
    metadataBlocks.has(index) ? [] : [{ block, kind: nonRulingBlock(block) }],
  );
  // A complete metadata line can sit between wrapped publisher-message parts
  // in one paragraph. Only exact full consumption can reject that remainder;
  // every other path keeps the original candidate blocks.
  const publisherRemainder = remainder
    .map(({ block }) =>
      block
        .split("\n")
        .map((line) => line.replace(/\s+/gu, " ").trim())
        .filter((line) => !isMetadata(line))
        .join(" "),
    )
    .join(" ");
  if (isSourcePlaceholderSequence(publisherRemainder)) {
    return COURTLISTENER_TEXT_USABILITY.SOURCE_PLACEHOLDER;
  }
  const rulingBlocks: string[] = [];
  const hasPlaceholder = remainder.some(({ kind }) => kind === "placeholder");
  const hasMetadata = metadataBlocks.size > 0;
  for (const { block, kind } of remainder) {
    switch (kind) {
      case "metadata":
        break;
      case "placeholder":
        break;
      case null:
        rulingBlocks.push(block);
        break;
      default:
        kind satisfies never;
        return panic("Unhandled non-ruling block classification");
    }
  }
  if (rulingBlocks.length > 0 && rulingBlocks.every(isAsciiPunctuationOnly)) {
    return hasPlaceholder
      ? COURTLISTENER_TEXT_USABILITY.SOURCE_PLACEHOLDER
      : COURTLISTENER_TEXT_USABILITY.NO_RULING_TEXT;
  }
  if (
    hasMetadata &&
    rulingBlocks.length > 0 &&
    rulingBlocks.every(isOcrDateFragment)
  ) {
    return hasPlaceholder
      ? COURTLISTENER_TEXT_USABILITY.SOURCE_PLACEHOLDER
      : COURTLISTENER_TEXT_USABILITY.NO_RULING_TEXT;
  }
  if (blocks.length > 0 && remainder.length === 0) {
    return COURTLISTENER_TEXT_USABILITY.NO_RULING_TEXT;
  }
  if (blocks.length > 0 && rulingBlocks.length === 0) {
    // An explicit publisher replacement is more specific than missing ruling text.
    return hasPlaceholder
      ? COURTLISTENER_TEXT_USABILITY.SOURCE_PLACEHOLDER
      : COURTLISTENER_TEXT_USABILITY.NO_RULING_TEXT;
  }
  return classifyRulingText(rulingBlocks.join("\n\n").toLowerCase());
};

export const classifyCourtListenerText = (
  text: string,
): CourtListenerTextUsability => {
  const normalized = normalizeUnicode(text, "NFC").trim();
  // Normalize spacing before matching whole lines so names and whitespace
  // never compete for the same characters during backtracking.
  const unattributed = normalized
    .split("\n")
    .map((line) => {
      const compactLine = line.replace(/[^\S\r\n]+/gu, " ").trim();
      return isAttribution(compactLine) || isSignature(compactLine) ? "" : line;
    })
    .join("\n");
  const classification = classifyBody(unattributed);
  switch (classification) {
    case COURTLISTENER_TEXT_USABILITY.SOURCE_PLACEHOLDER:
    case COURTLISTENER_TEXT_USABILITY.USABLE:
    case COURTLISTENER_TEXT_USABILITY.NO_RULING_TEXT:
    case COURTLISTENER_TEXT_USABILITY.UNDECODABLE:
      return classification;
    default: {
      classification satisfies never;
      return panic("Unhandled CourtListener text classification");
    }
  }
};
