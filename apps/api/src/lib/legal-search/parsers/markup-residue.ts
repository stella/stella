/**
 * Source markup that survived into a decision's text.
 *
 * A parser that reads its source as a string rather than as a document
 * leaks the source's own encoding into the corpus: an RTF picture group's
 * control words and hex payload, an unescaped HTML tag, a PDF dictionary, a
 * half-decoded entity. The reader prints it, search indexes it and the AI
 * pipeline is prompted with it, and none of the three can tell it apart
 * from the court's words.
 *
 * The specific leak is always a parser bug and is fixed there. This is the
 * class-level guard: one cheap scan over the text every source produces, so
 * the next parser — in any jurisdiction, for any format — cannot introduce
 * the same defect silently. It runs inside `validateAndLog` for parsed
 * decisions and from the pipeline for sources whose parser never runs.
 *
 * Each rule also states the Postgres pattern that finds decisions already
 * stored with that residue; the sweep in
 * `handlers/case-law/AGENTS.md` is built from these, and a test holds the
 * two to exact agreement so the documented query cannot drift from the
 * check.
 */

/** What the text carried that a court did not write. */
const MARKUP_RESIDUE_RULE_IDS = [
  "rtf-control",
  "html-tag",
  "xml-marker",
  "pdf-object",
  "entity",
  "digit-run",
  "hex-run",
] as const;

export type MarkupResidueRuleId = (typeof MARKUP_RESIDUE_RULE_IDS)[number];

type MarkupResidueRule = {
  id: MarkupResidueRuleId;
  /** Why a court's text never looks like this. */
  reason: string;
  /** Global: a rule with an `accept` gate walks every match, not the first. */
  pattern: RegExp;
  /** Second gate for a pattern that matches more than it reports. */
  accept?: (match: string) => boolean;
  /**
   * The same shape as a Postgres pattern, spelled as it appears inside a
   * SQL string literal (so `\\` is one backslash to the regex engine).
   *
   * A candidate finder, not the adjudicator: where a length rule is
   * awkward to state in a POSIX ARE the pattern is deliberately the looser
   * superset, and the rows it returns are re-parsed, which is what decides.
   */
  sqlPattern: string;
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

/**
 * Ordered: the first rule that matches names the finding, so a run of 48
 * digits reports as a number rather than as hex.
 */
const MARKUP_RESIDUE_RULES: readonly MarkupResidueRule[] = [
  {
    id: "rtf-control",
    reason: "RTF control words",
    // Two control words in a row, or an ignorable destination. One alone is
    // not enough: a decision can quote a Windows path, and a single
    // backslashed word is what that looks like.
    pattern: /\{\\\*|\\[a-zA-Z]{1,32}-?\d{0,10}[\s{}]{0,4}\\[a-zA-Z]{1,32}/gu,
    sqlPattern:
      "(\\{\\\\\\*|\\\\[a-zA-Z]{1,32}-?[0-9]{0,10}[[:space:]{}]{0,4}\\\\[a-zA-Z]{1,32})",
  },
  {
    id: "html-tag",
    reason: "HTML tags",
    // A tag closed right after its name, or opened with an attribute.
    // Deliberately not a bare `<name`: "a<b " is arithmetic, not markup.
    pattern: /<\/?[a-zA-Z][a-zA-Z0-9-]{0,30}(?:\s+[a-zA-Z-]+\s*=|\s*\/?>)/gu,
    sqlPattern:
      "(</?[a-zA-Z][a-zA-Z0-9-]{0,30}([[:space:]]+[a-zA-Z-]+[[:space:]]*=|[[:space:]]*/?>))",
  },
  {
    id: "xml-marker",
    reason: "XML prologue or CDATA",
    pattern: /<\?xml[\s?]|<!\[CDATA\[|<!DOCTYPE\s/giu,
    sqlPattern: "(<\\?xml[[:space:]?]|<!\\[CDATA\\[|<!DOCTYPE[[:space:]])",
  },
  {
    id: "pdf-object",
    reason: "PDF object syntax",
    pattern: /<<\s*\/[a-zA-Z]|\bendobj\b|\bendstream\b/gu,
    sqlPattern: "(<<[[:space:]]*/[a-zA-Z]|\\mendobj\\M|\\mendstream\\M)",
  },
  {
    id: "entity",
    reason: "undecoded character entities",
    pattern: /&(?:[a-zA-Z]{2,12}|#\d{1,7});/gu,
    sqlPattern: "&([a-zA-Z]{2,12}|#[0-9]{1,7});",
  },
  {
    id: "digit-run",
    reason: "a digit run longer than any number a court writes",
    pattern: new RegExp(String.raw`\d{${DIGIT_RUN_MIN},}`, "gu"),
    sqlPattern: `[0-9]{${DIGIT_RUN_MIN},}`,
  },
  {
    id: "hex-run",
    reason: "an embedded binary payload",
    pattern: new RegExp(String.raw`[0-9a-fA-F]{${HEX_RUN_MIN},}`, "gu"),
    accept: (match) =>
      match.length >= HEX_RUN_DIGITS_ONLY_MIN || /[a-f]/iu.test(match),
    sqlPattern: `[0-9a-fA-F]{${HEX_RUN_MIN},}`,
  },
];

/**
 * What the documented sweep must contain: every rule, with the Postgres
 * pattern that finds the rows it would report.
 */
export const markupResidueSweepRules = (): readonly {
  id: MarkupResidueRuleId;
  sqlPattern: string;
}[] => MARKUP_RESIDUE_RULES.map(({ id, sqlPattern }) => ({ id, sqlPattern }));

export type MarkupResidue = {
  rule: MarkupResidueRuleId;
  reason: string;
  /** The offending text, bounded so a log line stays a log line. */
  excerpt: string;
};

/**
 * The first residue in `text`, or undefined when it reads as a document.
 *
 * First rather than every: the finding is a parser bug report, and one
 * anchored excerpt is what an operator needs to find the parser. Scanning
 * on is only cost, and a picture payload would produce thousands.
 */
export const markupResidueIn = (text: string): MarkupResidue | undefined => {
  for (const rule of MARKUP_RESIDUE_RULES) {
    rule.pattern.lastIndex = 0;
    let match = rule.pattern.exec(text);
    while (match) {
      if (!rule.accept || rule.accept(match[0])) {
        return {
          rule: rule.id,
          reason: rule.reason,
          excerpt: text
            .slice(match.index, match.index + MARKUP_RESIDUE_EXCERPT_CHARS)
            .trim(),
        };
      }
      match = rule.pattern.exec(text);
    }
  }
  return undefined;
};
