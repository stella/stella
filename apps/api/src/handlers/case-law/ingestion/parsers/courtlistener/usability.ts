import { DANGEROUS_CHARS } from "@stll/legal-ast/text-sanitize";

export const COURTLISTENER_TEXT_USABILITY = {
  USABLE: "usable",
  SOURCE_PLACEHOLDER: "source-placeholder",
  NO_RULING_TEXT: "no-ruling-text",
  UNDECODABLE: "undecodable",
} as const;

export type CourtListenerTextUsability =
  (typeof COURTLISTENER_TEXT_USABILITY)[keyof typeof COURTLISTENER_TEXT_USABILITY];

// CourtListener and the courts it republishes use these messages in place of
// document bodies. Match the whole message, never a quotation within an opinion.
const SOURCE_PLACEHOLDERS = [
  /^(?:unable|failed) to extract (?:document )?(?:content|text)[.!]?$/u,
  /^no opinion found\s*\.?\s*(?:click here to view source material[.!]?)?$/u,
  /^(?:usca\d+\s+)?opinion (?:can't|cannot|could not) open\s+\S+$/u,
  /^(?:this )?opinion\b.{0,100}\b(?:was|has been) (?:never (?:issued|released)|withdrawn)(?: or was withdrawn)?[.!]?(?:\s+opinion\s*#\s*[\w-]+(?:\s*['’])?)?$/u,
  /^decision removed at the request of the court[.!]?$/u,
  /^entry removed as entered in error[.!]?$/u,
  /^(?:file\s+)?unavailable[.!]?$/u,
  /^memorandum decisions?[.!]?$/u,
  /^test(?:ing)? (?:document|pdf)[.!]?$/u,
] as const;

const MONTH =
  "(?:january|february|march|april|may|june|july|august|september|october|november|december)";
const WRITTEN_DATE = new RegExp(
  `\\b(?:${MONTH}\\s+\\d{1,2},?\\s+\\d{2,4}|\\d{1,2}\\s+${MONTH}\\s+\\d{2,4})\\b`,
  "gu",
);
const DATE_ONLY = new RegExp(`^${MONTH}\\d{1,2},?\\d{4}$`, "u");

// A title after a personal name is attribution; "per curiam" is deliberately
// absent because it is itself a published short ruling.
const ATTRIBUTION =
  /(?:^|\n)[^\S\r\n]*(?:opinion\s+by\s+)?[\p{L}'’-]+(?:[^\S\r\n]+(?:[\p{L}'’-]+|\p{L}\.)){0,8},[^\S\r\n]*(?:(?:[cp]\s*\.\s*)?j\s*\.|c\s*\.\s*j\s*\.|(?:bankruptcy\s+)?judge)[^\S\r\n]*[:.]?[^\S\r\n]*(?=\n|$)/gu;
const SIGNATURE = /(?:^|\n)\s*\/s\/\s*[\p{L}.'’\- ]+(?=\n|$)/gu;
const AUTHOR_INTRODUCTION =
  /^(?:mr\.\s+)?justice\s+[\p{L}.'’\- ]+\s+delivered the opinion of the court[.!]?$/u;
const AUTHOR_PUBLICATION_NOTE =
  /^opinion by\s+justice\s+[\p{L}.'’\- ]+\.\s+not to be published in full[.!]?$/u;
const COURT_HEADER =
  /^(?:in the\s+)?\p{L}+(?:\s+\p{L}+){0,3}\s+court of appeals\s+for the\s+[\p{L} ]+\s+circuit[.!]?$/u;
const FILING_HEADER =
  /^case\s*:?\s*[\w:.-]+\s+(?:document\s+\d+\s+)?(?:date\s+)?filed\s*:?\s*\d+[\d/.-]*\s+page\s*:?\s*\d+\s+of\s+\d+$/u;
const PARTICIPATION_NOTE =
  /^(?:judge\s+[\p{L}'’\- ]+\s+took no part|present\s*[—:-]\s+[\p{L}.,'’\- ]+\b(?:jj|j)\.)[.!]?$/u;
const OFFICE_HEADER =
  /^[^\p{L}]*office of\s+(?:the\s+)?[\p{L}'’]+(?:\s+general)?(?:\s+of\s+\p{L}+)?(?:\s+[\p{L}]+)?[^\p{L}]*(?:\s+[a-z])?$/u;
const DAMAGED_OFFICE_HEADER =
  /^(?:office of\b|[\p{L}'’]+\s+[\p{L}'’[\]]+ general\b)[\s\S]{0,100}$/u;
const COURT_IDENTIFIER =
  /^\d{4}\s+[a-z]{2,4}\s+(?:super|app|sup)\s+\d+[a-z]?(?:\s+[\da-z]+)?$/u;
// Preserve very short dispositions; readable sentences do not need these words.
const RULING_WORDS =
  /^[\s[(]*(?:affirm(?:ed)?|den(?:y|ied)|grant(?:ed)?|dismiss(?:ed)?|revers(?:e|ed)|remand(?:ed)?|ordered|per\s+curiam)[\s.!\])]*$/u;

const isMetadata = (text: string): boolean =>
  AUTHOR_INTRODUCTION.test(text) ||
  AUTHOR_PUBLICATION_NOTE.test(text) ||
  COURT_HEADER.test(text) ||
  FILING_HEADER.test(text) ||
  PARTICIPATION_NOTE.test(text) ||
  OFFICE_HEADER.test(text) ||
  COURT_IDENTIFIER.test(text) ||
  DATE_ONLY.test(text.replace(/\s+/gu, ""));

const hasReadableSentence = (text: string): boolean => {
  const compactBody = text.replace(/\s+/gu, " ").trim();
  if (
    AUTHOR_INTRODUCTION.test(compactBody) ||
    AUTHOR_PUBLICATION_NOTE.test(compactBody) ||
    SOURCE_PLACEHOLDERS.some((pattern) => pattern.test(compactBody))
  ) {
    return false;
  }
  for (const paragraph of text.split(/\n\s*\n/gu)) {
    const compact = paragraph.replace(/\s+/gu, " ").trim();
    if (isMetadata(compact)) {
      continue;
    }
    // Inspect each sentence separately so a damaged header cannot outweigh an
    // intact sentence, and a publisher message cannot supply its word tokens.
    for (const sentence of compact.match(/[^.!?。！？]+[.!?。！？]+/gu) ?? []) {
      const candidate = sentence.trim();
      if (
        SOURCE_PLACEHOLDERS.some((pattern) => pattern.test(candidate)) ||
        isMetadata(candidate) ||
        /^(?:click here to view source material|not to be published in full)[.!]?$/u.test(
          candidate,
        )
      ) {
        continue;
      }
      const tokens = candidate.match(/\S+/gu) ?? [];
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

type TextDecodabilityOptions = {
  remaining: string;
  unattributed: string;
};

const isUndecodable = ({
  remaining,
  unattributed,
}: TextDecodabilityOptions): boolean => {
  const compact = unattributed.replace(/\s+/gu, " ").trim();
  // UTF-16 decoded as a single-byte encoding and replacement/control bytes
  // cannot supply a word. A genuine word elsewhere still remains admissible.
  const readable = remaining
    .replace(/(?:ÿþ|þÿ)[\p{L}\p{N}]*/gu, " ")
    .replace(DANGEROUS_CHARS, " ")
    .replace(/\ufffd/gu, " ");
  const letters = readable.match(/\p{L}/gu)?.length ?? 0;
  const punctuation = readable.match(/[^\p{L}\p{N}\s]/gu)?.length ?? 0;
  const damagedWord = /\p{L}[~+?![]\p{L}|\p{L}~~\p{L}/u.test(readable);
  const intactWords =
    readable.match(/(?<![\p{L}\p{N}])\p{L}+(?![\p{L}\p{N}])/gu) ?? [];
  const tokens = readable.match(/\S+/gu) ?? [];
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
      /general[^\S\r\n]*\n/u.test(unattributed) &&
      /[!?[]\p{L}/u.test(compact))
  ) {
    return true;
  }
  return !/\p{L}{2}/u.test(readable);
};

export const classifyCourtListenerText = (
  text: string,
): CourtListenerTextUsability => {
  const normalized = text.toLowerCase().trim();
  const unattributed = normalized
    .replace(ATTRIBUTION, "\n")
    .replace(SIGNATURE, "\n");
  const compact = unattributed.replace(/\s+/gu, " ").trim();
  if (hasReadableSentence(unattributed)) {
    return COURTLISTENER_TEXT_USABILITY.USABLE;
  }
  if (SOURCE_PLACEHOLDERS.some((pattern) => pattern.test(compact))) {
    return COURTLISTENER_TEXT_USABILITY.SOURCE_PLACEHOLDER;
  }
  if (unattributed.split(/\n/gu).some((line) => RULING_WORDS.test(line))) {
    return COURTLISTENER_TEXT_USABILITY.USABLE;
  }
  if (isMetadata(compact)) {
    return COURTLISTENER_TEXT_USABILITY.NO_RULING_TEXT;
  }

  const remaining = unattributed
    .replace(WRITTEN_DATE, " ")
    // A suffix cannot consume the letter opening the next exemption code.
    .replace(/\([a-z]\)\s*\(\d+\)(?:\s*\([a-z]\)(?!\s*\(\d+\)))?/gu, " ")
    .replace(/\bappendix\s+\d+\b/gu, " ")
    .replace(/\b\d+[\d/.,: -]*\b/gu, " ")
    .replace(/\b(?:for|at|of|the|and|to|in|on)\b/gu, " ")
    .trim();
  if (
    /^(?:(?:amended\s+)?memorandum opinion|decision)[\s.!]*$/u.test(remaining)
  ) {
    return COURTLISTENER_TEXT_USABILITY.NO_RULING_TEXT;
  }
  if (!/\p{L}/u.test(remaining)) {
    return /\d/u.test(normalized) || !remaining
      ? COURTLISTENER_TEXT_USABILITY.NO_RULING_TEXT
      : COURTLISTENER_TEXT_USABILITY.UNDECODABLE;
  }
  return isUndecodable({ remaining, unattributed })
    ? COURTLISTENER_TEXT_USABILITY.UNDECODABLE
    : COURTLISTENER_TEXT_USABILITY.USABLE;
};
