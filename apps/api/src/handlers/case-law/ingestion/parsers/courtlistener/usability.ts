import { panic } from "better-result";

import { DANGEROUS_CHARS } from "@stll/legal-ast/text-sanitize";

export const COURTLISTENER_TEXT_USABILITY = {
  USABLE: "usable",
  SOURCE_PLACEHOLDER: "source-placeholder",
  NO_RULING_TEXT: "no-ruling-text",
  UNDECODABLE: "undecodable",
} as const;

export type CourtListenerTextUsability =
  (typeof COURTLISTENER_TEXT_USABILITY)[keyof typeof COURTLISTENER_TEXT_USABILITY];

// These complete replacement messages come from the census and reviewed fixtures.
// The list deliberately preserves exact identities instead of generalizing IDs.
const SOURCE_PLACEHOLDER_MESSAGES = [
  "decision removed at the request of the court.",
  "entry removed as entered in error",
  "failed to extract text.",
  "file unavailable",
  "memorandum decisions",
  "memorandum decisions.",
  "no opinion found. click here to view source material.",
  "no opinion found.click here to view source material.",
  "opinion # ms 568 was never issued or was withdrawn.",
  "opinion # ww-1432 was never issued.",
  "opinion # ww-1239 was never issued.",
  "opinion # ww11177 was never released.",
  "opinion # ww-1145 was never released.",
  "opinion # ww-915 was never issued.",
  "opinion # zz-98765 was never issued.",
  "opinion # xy-678 was never released.",
  "opinion los 7463 was never issued oh was withdrawn.",
  "opinion x ww-1167 was never issued.",
  "test document",
  "test pdf",
  "testing document",
  "this opinion has been withdrawn. opinion #c-473",
  "this opinion was never issued. opinion # ww-1119 '",
  "this opinion was withdrawn. opinion # wws560",
  "unable to extract document content",
  "unavailable",
  "usca1 opinion can't open 09-2406e.01a.",
  "usca1 opinion can't open 15-1424p2.01b",
  "usca1 opinion can't open 15-1544p.01a.",
  "usca1 opinion can't open 19-1490p.01",
  "usca1 opinion can't open 19-2192p.01",
  "usca1 opinion can't open 19-1389p.01",
  "usca1 opinion can't open 20-1136p.01",
  "usca1 opinion can't open 21-1479p.01",
  "usca2 opinion can't open 24-9876a.pdf",
  "opinion # ms 035 was never issued or was withdrawn.",
  "opinion # ww-160 was never issued.",
  "opinion # ww-6491 was never issued.",
  "opinion # ww-6670 was never released.",
  "opinion # ww-6794 was never issued.",
  "opinion # ww66622 was never released.",
  "opinion los 2739 was never issued oh was withdrawn.",
  "opinion x ww-6632 was never issued.",
  "this opinion has been withdrawn. opinion #c-729",
  "this opinion was never issued. opinion # ww-6661 '",
  "this opinion was withdrawn. opinion # wws038",
  "usca6 opinion can't open 46-6721p.86",
  "usca6 opinion can't open 48-6693p.86",
  "usca6 opinion can't open 60-6077p.86a.",
  "usca6 opinion can't open 60-6747p4.86b",
  "usca6 opinion can't open 61-4614p.86",
  "usca6 opinion can't open 61-6718p.86",
  "usca6 opinion can't open 61-6951p.86",
  "usca6 opinion can't open 81-4783e.86a.",
] as const;

const normalizeSourcePlaceholder = (text: string): string =>
  text.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
const SOURCE_PLACEHOLDERS = new Set(
  SOURCE_PLACEHOLDER_MESSAGES.map(normalizeSourcePlaceholder),
);

const isSourcePlaceholder = (text: string): boolean =>
  SOURCE_PLACEHOLDERS.has(normalizeSourcePlaceholder(text));

const SOURCE_PLACEHOLDER_WORD_SEQUENCES = Array.from(
  SOURCE_PLACEHOLDERS,
  (message) => message.split(" "),
);

// Every token must belong to a complete closed message; whitespace may wrap or
// separate messages, but unknown tokens always remain candidate ruling text.
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
    for (const messageWords of SOURCE_PLACEHOLDER_WORD_SEQUENCES) {
      const end = start + messageWords.length;
      if (
        end <= words.length &&
        messageWords.every((word, offset) => words[start + offset] === word)
      ) {
        matches[end] = 1;
      }
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

// A title after a personal name is attribution; "per curiam" is deliberately
// absent because it is itself a published short ruling.
const ATTRIBUTION =
  /^(?:opinion by )?[\p{L}'’-]+(?: (?:[\p{L}'’-]+|\p{L}\.)){0,8}, ?(?:(?:[cp] ?\. ?)?j ?\.|c ?\. ?j ?\.|(?:bankruptcy )?judge)(?: ?[:.]| )?$/u;
const SIGNATURE = /^\/s\/ ?[\p{L}.'’\- ]+$/u;
const AUTHOR_INTRODUCTION =
  /^(?:mr\. )?justice [\p{L}.'’-]+(?: [\p{L}.'’-]+)* delivered the opinion of the court[.!]?$/u;
const AUTHOR_PUBLICATION_NOTE =
  /^opinion by justice [\p{L}.'’-]+(?: [\p{L}.'’-]+)*\. not to be published in full[.!]?$/u;
const COURT_HEADER =
  /^(?:in the )?\p{L}+(?: \p{L}+){0,3} court of appeals for the \p{L}+(?: \p{L}+)* circuit[.!]?$/u;
const FILING_HEADER =
  /^case ?:? ?[\w:.-]+ (?:document \d+ )?(?:date )?filed ?:? ?\d[\d/.-]* page ?:? ?\d+ of \d+$/u;
const PARTICIPATION_NOTE =
  /^(?:judge [\p{L}'’-]+(?: [\p{L}'’-]+)* took no part|present ?[—:-] ?[\p{L}.,'’-]+(?: [\p{L}.,'’-]+)* (?:jj|j)\.)[.!]?$/u;
const OFFICE_HEADER =
  /^[^\p{L}]*office of (?:the )?[\p{L}'’]+(?: general)?(?: of \p{L}+)?[^\p{L}'’]*$/u;
const DAMAGED_OFFICE_HEADER =
  /^(?:office of\b|[\p{L}'’]+\s+[\p{L}'’[\]]+ general\b)[\s\S]{0,100}$/u;
const COURT_IDENTIFIER =
  /^\d{4}\s+[a-z]{2,4}\s+(?:super|app|sup)\s+\d+[a-z]?(?:\s+[\da-z]+)?$/u;
// Preserve very short dispositions; readable sentences do not need these words.
const RULING_WORDS =
  /^[\s[(]*(?:affirm(?:ed)?|den(?:y|ied)|grant(?:ed)?|dismiss(?:ed)?|revers(?:e|ed)|remand(?:ed)?|ordered|per\s+curiam)[\s.!\])]*$/u;

const isOfficeHeader = (text: string): boolean => {
  let end = 0;
  for (const match of text.matchAll(/\p{L}/gu)) {
    end = match.index + match[0].length;
  }
  return OFFICE_HEADER.test(text.slice(0, end));
};

const isMetadata = (text: string): boolean =>
  AUTHOR_INTRODUCTION.test(text) ||
  AUTHOR_PUBLICATION_NOTE.test(text) ||
  COURT_HEADER.test(text) ||
  FILING_HEADER.test(text) ||
  PARTICIPATION_NOTE.test(text) ||
  isOfficeHeader(text) ||
  COURT_IDENTIFIER.test(text) ||
  DATE_ONLY.test(text.replace(/\s+/gu, ""));

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
  const compactBody = text.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (
    AUTHOR_INTRODUCTION.test(compactBody) ||
    AUTHOR_PUBLICATION_NOTE.test(compactBody) ||
    isSourcePlaceholderSequence(compactBody)
  ) {
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

const isExplicitNoRulingBody = (text: string): boolean => {
  if (isMetadata(text) || isAsciiPunctuationOnly(text)) {
    return true;
  }
  const compact = text.replace(/\s+/gu, " ").trim();
  if (/^(?:(?:amended )?memorandum opinion|decision)[\s.!]*$/u.test(compact)) {
    return true;
  }
  const tokens = compact.toLowerCase().split(" ");
  return (
    tokens.some((token) => /^\d/u.test(token)) &&
    tokens.every(
      (token) =>
        /^(?:for|at|of|the)$/u.test(token) || /^\d[\d/.,:-]*$/u.test(token),
    )
  );
};

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
  const completeBody = unattributed.replace(/\s+/gu, " ").trim();
  if (isSourcePlaceholderSequence(completeBody)) {
    return COURTLISTENER_TEXT_USABILITY.SOURCE_PLACEHOLDER;
  }
  if (isExplicitNoRulingBody(completeBody)) {
    return COURTLISTENER_TEXT_USABILITY.NO_RULING_TEXT;
  }
  const blocks = unattributed
    .split(/\n[^\S\n]*\n/gu)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const rulingBlocks: string[] = [];
  let hasPlaceholder = false;
  let hasMetadata = false;
  for (const block of blocks) {
    const kind = nonRulingBlock(block);
    switch (kind) {
      case "metadata":
        hasMetadata = true;
        break;
      case "placeholder":
        hasPlaceholder = true;
        break;
      case null:
        rulingBlocks.push(block);
        break;
      default:
        kind satisfies never;
        return panic("Unhandled non-ruling block classification");
    }
  }
  const nonPlaceholderText = rulingBlocks
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
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
  if (rulingBlocks.length > 1 && isMetadata(nonPlaceholderText)) {
    return hasPlaceholder
      ? COURTLISTENER_TEXT_USABILITY.SOURCE_PLACEHOLDER
      : COURTLISTENER_TEXT_USABILITY.NO_RULING_TEXT;
  }
  if (blocks.length > 0 && rulingBlocks.length === 0) {
    // An explicit publisher replacement is more specific than missing ruling text.
    return hasPlaceholder
      ? COURTLISTENER_TEXT_USABILITY.SOURCE_PLACEHOLDER
      : COURTLISTENER_TEXT_USABILITY.NO_RULING_TEXT;
  }
  return classifyRulingText(rulingBlocks.join("\n\n"));
};

export const classifyCourtListenerText = (
  text: string,
): CourtListenerTextUsability => {
  const normalized = text.toLowerCase().trim();
  // Normalize spacing before matching whole lines so names and whitespace
  // never compete for the same characters during backtracking.
  const unattributed = normalized
    .split("\n")
    .map((line) => {
      const compactLine = line.replace(/[^\S\r\n]+/gu, " ").trim();
      return ATTRIBUTION.test(compactLine) || SIGNATURE.test(compactLine)
        ? ""
        : line;
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
