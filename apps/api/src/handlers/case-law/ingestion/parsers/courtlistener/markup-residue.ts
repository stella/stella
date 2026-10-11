import { entityResidueIn } from "@/api/lib/legal-search/parsers/entity-residue";
import type { MarkupResidueRuleId } from "@/api/lib/legal-search/parsers/markup-residue";

const entityCharacterReferencePattern =
  /&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]*);/gu;

/** CourtListener's publisher grammar, used only by its explicit validation policy. */

type MarkupResidueRule = {
  id: MarkupResidueRuleId;
  /** Why a court's text never looks like this. */
  reason: string;
  /** Global: a rule with an `accept` gate walks every match, not the first. */
  pattern: RegExp;
  /** Second gate for a pattern that matches more than it reports. */
  accept?: (match: string) => boolean;
};

/**
 * A run of digits long enough that no number a court writes reaches it.
 *
 * Measured on contiguous digits, never across separators: an IČO is 8, a
 * Czech account number with its separators is at most 26, a docket, an
 * ECLI, an ISBN and a phone number all break long before this. A hex
 * payload written by a picture or an embedded object does not.
 */
const DIGIT_RUN_MIN = 40;

/** Hex is only text when it is short; a long run is a payload. */
const HEX_RUN_MIN = 32;

/** …and a run with no letters in it has to be longer to count as hex. */
const HEX_RUN_DIGITS_ONLY_MIN = 48;

/** How much of the offending text a report carries. */
const MARKUP_RESIDUE_EXCERPT_CHARS = 120;

// Recognized control words distinguish RTF syntax from OCR fragments and
// published Windows paths. This detection vocabulary is broader than the
// reader's supported dialect; detecting a word does not imply parsing it.
const RTF_CONTROL_WORDS = [
  "rtf",
  "ansi",
  "mac",
  "pc",
  "pca",
  "ansicpg",
  "deff",
  "deflang",
  "fonttbl",
  "f",
  "fnil",
  "froman",
  "fswiss",
  "fmodern",
  "fcharset",
  "colortbl",
  "red",
  "green",
  "blue",
  "stylesheet",
  "s",
  "cs",
  "pard",
  "plain",
  "par",
  "b",
  "i",
  "ul",
  "ulnone",
  "fs",
  "cf",
  "u",
  "uc",
  "tab",
  "line",
  "page",
  "qc",
  "ql",
  "qr",
  "qj",
  "pict",
  "pngblip",
  "jpegblip",
  "wmetafile",
  "dibitmap",
  "picprop",
  "shppict",
  "nonshppict",
  "shplid",
  "picw",
  "pich",
  "picwgoal",
  "pichgoal",
  "object",
  "objemb",
  "objdata",
  "trowd",
  "intbl",
  "cell",
  "row",
  "cellx",
  "li",
  "ri",
  "fi",
  "sa",
  "sb",
  "sl",
  "slmult",
  "insrsid",
  "lang",
].join("|");
const RTF_CONTROL_WORD = String.raw`\\(?:${RTF_CONTROL_WORDS})(?![a-zA-Z])-?\d{0,10}`;

/**
 * Ordered: the first rule that matches names the finding, so a run of 48
 * digits reports as a number rather than as hex.
 */
const MARKUP_RESIDUE_RULES: readonly MarkupResidueRule[] = [
  {
    id: "rtf-control",
    reason: "RTF control words",
    // Complete known control words, not arbitrary backslashed letters.
    // The group/header forms also catch unknown ignorable destinations.
    pattern: new RegExp(
      String.raw`\{\\\*|\{\\rtf\d{1,10}(?!\d)|${RTF_CONTROL_WORD}[\s{}]{0,4}${RTF_CONTROL_WORD}`,
      "gu",
    ),
  },
  {
    id: "html-tag",
    reason: "HTML tags",
    // A tag closed right after its name, or opened with an attribute.
    // Deliberately not a bare `<name`: "a<b " is arithmetic, not markup.
    pattern: /<\/?[a-zA-Z][a-zA-Z0-9-]{0,30}(?:\s+[a-zA-Z-]+\s*=|\s*\/?>)/gu,
  },
  {
    id: "xml-marker",
    reason: "XML prologue or CDATA",
    pattern: /<\?xml[\s?]|<!\[CDATA\[|<!DOCTYPE\s/giu,
  },
  {
    id: "pdf-object",
    reason: "PDF object syntax",
    pattern: /<<\s*\/[a-zA-Z]|\bendobj\b|\bendstream\b/gu,
  },
  {
    id: "entity",
    reason: "undecoded character entities",
    pattern: new RegExp(entityCharacterReferencePattern, "gu"),
    // The SQL pattern is intentionally a candidate superset; unknown
    // publisher literals have the same shape but are not character refs.
    // parser-output-unchanged: only logged elsewhere; gating parsers (pl-nsa, pl-uodo, CourtListener) bump
    accept: (match) => entityResidueIn(match) !== undefined,
  },
  {
    id: "digit-run",
    reason: "a digit run longer than any number a court writes",
    pattern: new RegExp(String.raw`\d{${DIGIT_RUN_MIN},}`, "gu"),
  },
  {
    id: "hex-run",
    reason: "an embedded binary payload",
    pattern: new RegExp(String.raw`[0-9a-fA-F]{${HEX_RUN_MIN},}`, "gu"),
    accept: (match) =>
      match.length >= HEX_RUN_DIGITS_ONLY_MIN || /[a-f]/iu.test(match),
  },
];

type MarkupResidue = {
  rule: MarkupResidueRuleId;
  reason: string;
  /** The offending text, bounded so a log line stays a log line. */
  excerpt: string;
};

// Citation URLs may wrap after a path separator or hyphen. Index their spans
// once, so rejecting multiple hashes in one long URL stays linear in the text.
const citationUrlRanges = (text: string): { start: number; end: number }[] => {
  const urls = /https?:\/\/[^\s<>]+/giu;
  const continuation = /[^\s<>]+/uy;
  const ranges = [];
  let url = urls.exec(text);
  while (url) {
    let end = urls.lastIndex;
    while (text.at(end - 1) === "-" || text.at(end - 1) === "/") {
      let newline = 0;
      if (text.startsWith("\r\n", end)) {
        newline = 2;
      } else if (text.at(end) === "\n") {
        newline = 1;
      }
      if (newline === 0) {
        break;
      }
      continuation.lastIndex = end + newline;
      if (!continuation.exec(text)) {
        break;
      }
      end = continuation.lastIndex;
    }
    ranges.push({ start: url.index, end });
    urls.lastIndex = end;
    url = urls.exec(text);
  }
  return ranges;
};

const isWalletAddress = (match: RegExpExecArray): boolean => {
  if (match[0].length !== 40) {
    return false;
  }
  const prefix = match.input.slice(Math.max(0, match.index - 3), match.index);
  if (!/(?:^|\W)0x$/iu.test(prefix)) {
    return false;
  }
  const following = match.input.at(match.index + match[0].length);
  return following === undefined || /\W/u.test(following);
};

type MarkupResidueMatch = MarkupResidue & { index: number; matched: string };

/**
 * Context-qualified matches shared by diagnostics and published-text classification.
 * @yields Context-qualified residue spans on the stored text axis.
 */
export function* markupResidueMatchesIn(
  text: string,
): Generator<MarkupResidueMatch> {
  for (const rule of MARKUP_RESIDUE_RULES) {
    const detectsPayload = rule.id === "digit-run" || rule.id === "hex-run";
    // Iterators may be interleaved; each owns its scan cursor.
    const pattern = rule.pattern.ignoreCase
      ? new RegExp(rule.pattern.source, "giu")
      : new RegExp(rule.pattern.source, "gu");
    let match = pattern.exec(text);
    const urlRanges = detectsPayload && match ? citationUrlRanges(text) : [];
    let urlIndex = 0;
    while (match) {
      if (detectsPayload) {
        let url = urlRanges.at(urlIndex);
        while (url && url.end <= match.index) {
          urlIndex += 1;
          url = urlRanges.at(urlIndex);
        }
        if (
          (url &&
            url.start <= match.index &&
            match.index + match[0].length <= url.end) ||
          isWalletAddress(match)
        ) {
          match = pattern.exec(text);
          continue;
        }
      }
      if (!rule.accept || rule.accept(match[0])) {
        yield {
          index: match.index,
          matched: match[0],
          rule: rule.id,
          reason: rule.reason,
          excerpt: text
            .slice(match.index, match.index + MARKUP_RESIDUE_EXCERPT_CHARS)
            .trim(),
        };
      }
      match = pattern.exec(text);
    }
  }
}

/** The first diagnostic only; full scanning is reserved for source attribution. */
export const markupResidueIn = (text: string): MarkupResidue | undefined => {
  const first = markupResidueMatchesIn(text).next();
  if (first.done) {
    return undefined;
  }
  const { rule, reason, excerpt } = first.value;
  return { rule, reason, excerpt };
};
