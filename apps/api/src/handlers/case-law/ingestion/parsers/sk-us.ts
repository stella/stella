// parser-output-unchanged: The retention check moved to the pipeline, which runs it against the stored XHTML; the parse itself is unchanged.
// parser-output-unchanged: Validation reparses the original XHTML before hidden-run normalization; stored parser output remains unchanged.
/**
 * Slovak Constitutional Court document parser (the markup rendering).
 *
 * `POST /o/v1/dms/content` answers with the decision as XHTML, which is the
 * same document the court also serves as a file. The markup is flat: one
 * `<div>`, a run of `<span style="font-size: Npx">` and `<br/>` for every
 * visual line, with no paragraph or heading element anywhere. So the
 * structure has to be read the way a reader reads it: the font size marks
 * the title, the court's own section words mark the parts, and a blank line
 * ends a paragraph.
 *
 * Blank lines are why this parser exists beside the file parser rather than
 * reusing it: in the markup a paragraph break is stated, while in the file
 * it has to be guessed from font and position. Both agree on what the parts
 * are called, which is the vocabulary they share.
 *
 * Redaction. The court anonymizes by painting a run black on black:
 * `<span style="color: #000000; background-color: #000000; …">` over a run
 * of `&nbsp;`. The span carries no words, so nothing is being uncovered
 * here; what it carries is a bar as wide as what it replaced. Replace it
 * with a visible anonymization marker. Some conversions omit the paint
 * and leave only the non-breaking
 * space run; those gaps must become visible before whitespace is trimmed.
 */

import { panic } from "better-result";
import * as cheerio from "cheerio";
import { type AnyNode, isTag, isText } from "domhandler";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { COURT_PARAGRAPH_NUMBERING_LIMITS } from "@stll/legal-ast/court-paragraph-numbers";
import { hasInlineChildren } from "@stll/legal-ast/document-ast";
// parser-output-unchanged: imports the document AST from its package owner
import type {
  Block,
  DocumentAst,
  HeadingBlock,
  Inline,
} from "@stll/legal-ast/document-ast";
import {
  mapInlineText,
  normalizeInlineLine,
  rewriteInlineWhitespace,
  stripInlinePrefix,
  stripInlineSuffix,
} from "@stll/legal-ast/inline-line";
import {
  isSkDecisionTitle,
  isSkHoldingMarker,
  isSkInstructionMarker,
  isSkReasoningMarker,
  isSkStandaloneInstructionMarker,
  SK_CLOSING_RE,
  SK_JUDGE_TITLE_RE,
  SK_ROMAN_DIVIDER_RE,
  skSectionHeading,
} from "@stll/legal-ast/slovak-document-roles";
import type { SkDocumentSection } from "@stll/legal-ast/slovak-document-roles";
import { normalizeUnicode } from "@stll/text-normalize";

import {
  ANONYMIZED_CLASS,
  inlinesToPlainText,
  isExcludedHtmlTag,
  walkInlines,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import { createBlockAnchorAllocator } from "@/api/lib/legal-search/parsers/block-anchors";
import { courtParagraphNumbers } from "@/api/lib/legal-search/parsers/court-paragraph-numbers";
import { collapseLetterSpacing } from "@/api/lib/legal-search/parsers/letter-spacing";

/**
 * What a dropped anonymized run reads as.
 *
 * The same word the file parser puts in place of a redaction gap, so the
 * two renderings of one decision do not describe the court's redactions
 * with two different words.
 */
const SK_US_ANONYMIZED_PLACEHOLDER = "anonymizované";

/** The shortest redaction run in the court's I. ÚS 442/2020 conversion. */
const REDACTION_GAP = /(\u00a0{4,})/u;

/** Retain unpainted redaction gaps, including lines containing only a gap. */
const preserveRedactionGaps = (inlines: readonly Inline[]): Inline[] =>
  inlines.flatMap((inline): Inline[] => {
    if (hasInlineChildren(inline)) {
      return [{ ...inline, children: preserveRedactionGaps(inline.children) }];
    }
    if (inline.type !== "text") {
      return [inline];
    }
    return inline.text
      .split(REDACTION_GAP)
      .filter((text) => text.length > 0)
      .map((text) =>
        REDACTION_GAP.test(text)
          ? {
              type: "text",
              text: SK_US_ANONYMIZED_PLACEHOLDER,
              anonymized: true,
            }
          : { ...inline, text },
      );
  });

/** The declaration that paints a run the colour of its own background. */
const HIDDEN_STYLE_PARTS = ["color: #000000", "background-color: #000000"];

const isHiddenStyle = (style: string): boolean => {
  const normalized = style.toLowerCase().replaceAll(/\s+/gu, " ");
  return HIDDEN_STYLE_PARTS.every((part) => normalized.includes(part));
};

/** Font size in points, from the span's own declaration. */
const FONT_SIZE_PATTERN = /font-size:\s*(?<size>\d+(?:\.\d+)?)px/u;

const fontSizeOf = (style: string | undefined): number => {
  const size = FONT_SIZE_PATTERN.exec(style ?? "")?.groups?.["size"];
  return size === undefined ? DEFAULT_FONT_SIZE : Number(size);
};

/** What a span with no declaration of its own is rendered at. */
const DEFAULT_FONT_SIZE = 12;

/** Above this, a run is the decision's title rather than its body. */
const TITLE_FONT_SIZE = 14;

/** One visual line of the document, with the size it was rendered at. */
type MarkupLine = {
  inlines: Inline[];
  text: string;
  fontSize: number;
  /** A blank line that separates two pages rather than two paragraphs. */
  pageBreak?: true;
};

/**
 * Replace every hidden run with the placeholder, in place.
 *
 * Marked with the class the inline walker reads rather than by the walker
 * learning about colours: the walker already carries anonymization down a
 * subtree, and this is the one place that knows how this court hides text.
 */
const markHiddenRuns = ($: cheerio.CheerioAPI): void => {
  $("span").each((_, element) => {
    const span = $(element);
    if (!isHiddenStyle(span.attr("style") ?? "")) {
      return;
    }
    span.addClass(ANONYMIZED_CLASS);
    span.text(SK_US_ANONYMIZED_PLACEHOLDER);
  });
};

/** Split one span's inlines into the lines its `<br/>` elements bound. */
const splitAtLineBreaks = (inlines: readonly Inline[]): Inline[][] => {
  const lines: Inline[][] = [[]];
  for (const inline of inlines) {
    if (inline.type === "line-break") {
      lines.push([]);
      continue;
    }
    lines.at(-1)?.push(inline);
  }
  return lines;
};

/**
 * The document's lines, in order, each carrying its own font size.
 *
 * Spans retain their own font signal while the surrounding DOM is walked
 * too, so content in paragraphs, cells, and bare text nodes is accounted
 * for without reading nested spans twice.
 */
const readMarkupLines = ($: cheerio.CheerioAPI): MarkupLine[] => {
  const lines: MarkupLine[] = [];
  let open: MarkupLine | null = null;

  const close = (): void => {
    if (open !== null) {
      lines.push(open);
      open = null;
    }
  };

  const appendRun = (inlines: readonly Inline[], fontSize: number): void => {
    for (const [index, lineInlines] of splitAtLineBreaks(inlines).entries()) {
      if (index > 0) {
        close();
      }
      const text = inlinesToPlainText(lineInlines);
      if (open === null) {
        open = { inlines: [...lineInlines], text, fontSize };
        continue;
      }
      open.inlines.push(...lineInlines);
      open.text += text;
      open.fontSize = Math.max(open.fontSize, fontSize);
    }
  };

  const visit = (node: cheerio.Cheerio<AnyNode>): void => {
    node.contents().each((_, child) => {
      if (isText(child)) {
        appendRun([{ type: "text", text: child.data }], DEFAULT_FONT_SIZE);
        return;
      }
      if (!isTag(child)) {
        return;
      }
      // A script's source and a stylesheet are markup, never the decision's
      // text, whatever element they sit in.
      if (isExcludedHtmlTag(child.name)) {
        return;
      }
      const element = $(child);
      if (child.name === "br") {
        close();
        return;
      }
      if (child.name === "span") {
        const fontSize = fontSizeOf(element.attr("style"));
        appendRun(
          walkInlines($, element, {
            anonymized: element.hasClass(ANONYMIZED_CLASS),
          }),
          fontSize,
        );
        return;
      }
      // Paragraphs and table cells are meaningful boundaries even when a
      // source omits spans and explicit <br/> elements.
      if (["p", "td", "th", "tr"].includes(child.name)) {
        close();
      }
      visit(element);
      if (["p", "td", "th", "tr"].includes(child.name)) {
        close();
      }
    });
  };

  visit($("body"));
  close();

  // A line's inlines are trimmed with its text, so a paragraph joined from
  // lines reads the same through either: the reader's text, and the text
  // left once a court number is cut off the inlines.
  for (const line of lines) {
    setInlines(line, preserveRedactionGaps(line.inlines));
  }
  return lines;
};

/** A number on a line of its own, which is this court's page footer. */
const PAGE_NUMBER_PATTERN = /^\d{1,4}$/u;

/**
 * The page number where the conversion to markup put it: before the first
 * word of the page's first line, or after the last word of the page's last
 * line, set apart by at least two spaces.
 */
const LEADING_PAGE_NUMBER = /^(?<number>\d{1,4})\s+(?=\S)/u;
const trailingPageNumber = (
  text: string,
): { number: number; length: number } | null => {
  const digits = /[0-9]{1,4}$/u.exec(text);
  if (digits === null) {
    return null;
  }
  let start = digits.index;
  while (start > 0 && /\s/u.test(text.charAt(start - 1))) {
    start -= 1;
  }
  if (digits.index - start < 2) {
    return null;
  }
  return {
    number: parseIntegerToken(digits[0]).unwrap(
      "Page-number grammar admits a bounded decimal token",
    ),
    length: text.length - start,
  };
};

/** Where a page number may stand, and how many characters it takes. */
type FooterCandidate = {
  readonly index: number;
  readonly number: number;
  /** Characters of text before the line, the page axis. */
  readonly offset: number;
  readonly form: "alone" | "leading" | "trailing";
  readonly length: number;
  /**
   * The document's last text: the final page's footer, after a page that
   * may hold only the closing lines.
   */
  readonly last: boolean;
};

const PAGE_SEQUENCE = {
  /** No page of a decision holds less text than this. */
  minPageChars: 1000,
  /** No page of a decision holds more text than this. */
  maxPageChars: 6000,
} as const;

/**
 * What a number opening a line counts when it is the text's: an amount, a
 * share, a measure or a period (`3 eurá`, `20 %`, `5 rokov`), or a docket's
 * senate and register (`5 Cdo 12/2020`). Such a number is never a page's.
 */
const COUNTED_AFTER_NUMBER =
  /^\d{1,4}\s+(?:(?:eur[aáoi]?|EUR|centov|centy|centa|Sk|Kč|korún|USD|%|€|\$|ks|kusov|kusy|m|km|m2|ha|kg|g|t|l|mm|cm|rok|roky|rokov|roka|rokoch|mesiac|mesiace|mesiacov|mesiaca|týždeň|týždne|týždňov|deň|dni|dní|dňa|dňoch|hodín|hodiny|hodinu|min|minút|percent|percentá|percenta|krát)(?=$|[\s.,;:)])|\p{Lu}\p{Ll}{0,3}\s+\d{1,6}\/\d)/u;

/**
 * Every line where a page number may stand: a number on a line of its own,
 * or one glued to a line that a blank line separates from the other page,
 * or to the document's last line.
 */
const footerCandidates = (lines: readonly MarkupLine[]): FooterCandidate[] => {
  const candidates: FooterCandidate[] = [];
  const isBlank = (index: number): boolean => lines[index]?.text === "";
  const lastText = lines.findLastIndex(({ text }) => text.length > 0);
  let offset = 0;
  for (const [index, { text }] of lines.entries()) {
    const leading =
      isBlank(index - 1) && !COUNTED_AFTER_NUMBER.test(text)
        ? LEADING_PAGE_NUMBER.exec(text)
        : null;
    const trailing =
      isBlank(index + 1) || index === lastText
        ? trailingPageNumber(text)
        : null;
    if (PAGE_NUMBER_PATTERN.test(text)) {
      candidates.push({
        index,
        number: parseIntegerToken(text).unwrap(
          "Page-number grammar admits a bounded decimal token",
        ),
        offset,
        form: "alone",
        length: text.length,
        last: index === lastText,
      });
    } else if (leading !== null) {
      candidates.push({
        index,
        number: parseIntegerToken(leading.groups?.["number"]).unwrap(
          "Page-number grammar admits a bounded decimal token",
        ),
        offset,
        form: "leading",
        length: leading[0].length,
        last: false,
      });
    } else if (trailing !== null) {
      candidates.push({
        index,
        number: trailing.number,
        offset: offset + text.length,
        form: "trailing",
        length: trailing.length,
        last: index === lastText,
      });
    }
    offset += text.length;
  }
  return candidates;
};

/**
 * The best run of page numbers ending at each candidate: numbers that
 * advance by one from the first page or the second, each a page of text
 * after the one before. Among runs as long, the one whose pages are closest
 * to `pageChars` in length.
 */
const pageRuns = (
  candidates: readonly FooterCandidate[],
  pageChars: number | null,
) => {
  const best = candidates.map(() => ({ length: 0, cost: 0, previous: -1 }));
  for (const [at, candidate] of candidates.entries()) {
    const first = candidate.number - 1;
    if (
      candidate.number <= 2 &&
      candidate.offset >= first * PAGE_SEQUENCE.minPageChars
    ) {
      best[at] = {
        length: 1,
        cost:
          pageChars === null
            ? 0
            : Math.abs(candidate.offset - first * pageChars),
        previous: -1,
      };
    }
    for (let before = 0; before < at; before += 1) {
      const previous = candidates[before];
      const step = best[before];
      if (
        previous === undefined ||
        step === undefined ||
        step.length === 0 ||
        previous.number !== candidate.number - 1 ||
        (!candidate.last &&
          candidate.offset - previous.offset < PAGE_SEQUENCE.minPageChars)
      ) {
        continue;
      }
      const length = step.length + 1;
      const cost =
        step.cost +
        (pageChars === null
          ? 0
          : Math.abs(candidate.offset - previous.offset - pageChars));
      const current = best[at];
      if (
        current !== undefined &&
        (length > current.length ||
          (length === current.length && cost < current.cost))
      ) {
        best[at] = { length, cost, previous: before };
      }
    }
  }
  return best;
};

/** The run ending at `at`, first page first. */
const runEndingAt = (
  candidates: readonly FooterCandidate[],
  best: ReturnType<typeof pageRuns>,
  at: number,
): FooterCandidate[] => {
  const members: FooterCandidate[] = [];
  for (let index = at; index >= 0; index = best[index]?.previous ?? -1) {
    const member = candidates[index];
    if (member === undefined || (best[index]?.length ?? 0) === 0) {
      return [];
    }
    members.unshift(member);
  }
  return members;
};

/**
 * The candidates that number the pages, or none.
 *
 * Numbers glued to body lines never vouch for each other: `3 eurá` and
 * `4 eurá` a page apart read like pages 3 and 4. What proves a document
 * paginated is a footer on a line of its own: the run must count every page
 * from the first up to such a footer (the anchor), each a page of text
 * after the one before. Past the last anchor, the run goes on only in the
 * form the anchored pages print their numbers in (all glued before a line,
 * or all after one) and only a page of text at a time, which is how a final
 * page without a footer of its own ends. Where one page number has more
 * than one candidate, the one that keeps the pages most alike wins.
 * Anything short of that keeps every number the document prints.
 */
const pageSequence = (
  candidates: readonly FooterCandidate[],
): FooterCandidate[] => {
  const anchorOf = (best: ReturnType<typeof pageRuns>): number => {
    let anchor = -1;
    for (const [at, candidate] of candidates.entries()) {
      if (
        candidate.form === "alone" &&
        runEndingAt(candidates, best, at).length > 0 &&
        candidate.number > (candidates[anchor]?.number ?? 0)
      ) {
        anchor = at;
      }
    }
    return anchor;
  };
  const rough = pageRuns(candidates, null);
  const roughRun = runEndingAt(candidates, rough, anchorOf(rough));
  const head = roughRun.at(0);
  const tail = roughRun.at(-1);
  if (head === undefined || tail === undefined) {
    return [];
  }
  const pageChars =
    head === tail
      ? head.offset / Math.max(1, head.number - 1)
      : (tail.offset - head.offset) / (tail.number - head.number);
  const best = pageRuns(candidates, pageChars);
  const anchor = anchorOf(best);
  const run = runEndingAt(candidates, best, anchor);
  const glued = run.filter(({ form }) => form !== "alone");
  if (run.length === 0 || glued.some(({ form }) => form !== glued[0]?.form)) {
    return run;
  }
  // Past the anchor: one form of glued number, a page at a time.
  let form = glued.at(0)?.form;
  let last = run.at(-1);
  for (const candidate of candidates.slice(anchor + 1)) {
    if (
      last === undefined ||
      candidate.number !== last.number + 1 ||
      (candidate.form !== "alone" &&
        form !== undefined &&
        candidate.form !== form)
    ) {
      continue;
    }
    const gap = candidate.offset - last.offset;
    if (
      candidate.last ||
      (gap >= PAGE_SEQUENCE.minPageChars && gap <= PAGE_SEQUENCE.maxPageChars)
    ) {
      run.push(candidate);
      last = candidate;
      form ??= candidate.form === "alone" ? undefined : candidate.form;
    }
  }
  return run;
};

/**
 * Remove the page numbers the court prints, and mark the blank lines around
 * them as page breaks rather than paragraph breaks.
 *
 * The markup is a conversion of the court's file, and it keeps the file's
 * footer: every page's number, glued to the first line of the next page
 * (`2 Ústavnému súdu bol …`, `5 II.`, `2 4. Obsah …`) or to the last line of
 * the page (`… (ďalej len    2`), with a blank line between the pages
 * whether or not a paragraph ends there. Read as text, the number becomes
 * the first word of a sentence, hides a section numeral or a paragraph
 * number, and the blank line cuts a sentence in two.
 *
 * A number is removed only as a member of a page sequence that a footer on
 * a line of its own proves (see {@link pageSequence}): a blank line before
 * `2 eurá.` does not make the amount a page number, and a document that
 * does not prove its pages keeps every number it prints.
 */
const removePageFurniture = (lines: readonly MarkupLine[]): MarkupLine[] => {
  const result = lines.map((line) => ({ ...line }));
  const isBlank = (index: number): boolean => result[index]?.text === "";
  const markBreak = (from: number, step: 1 | -1): void => {
    for (let index = from; isBlank(index); index += step) {
      const blank = result[index];
      if (blank !== undefined) {
        blank.pageBreak = true;
      }
    }
  };
  for (const { index, form, length } of pageSequence(
    footerCandidates(result),
  )) {
    const line = result[index];
    if (line === undefined) {
      continue;
    }
    switch (form) {
      case "alone":
        // Dropped by the classifier as a footer whatever its number.
        markBreak(index - 1, -1);
        markBreak(index + 1, 1);
        break;
      case "leading":
        setInlines(line, stripInlinePrefix(line.inlines, length));
        markBreak(index - 1, -1);
        break;
      case "trailing":
        setInlines(line, stripInlineSuffix(line.inlines, length));
        markBreak(index + 1, 1);
        break;
      default:
        form satisfies never;
        panic("Unhandled page footer form");
    }
  }
  return result;
};

/** Give a line new inlines, and the text they read as. */
const setInlines = (line: MarkupLine, inlines: readonly Inline[]): void => {
  const normalized = normalizeInlineLine(inlines);
  line.inlines = normalized.inlines;
  line.text = normalized.plainText;
};

/** U+00AD, the soft hyphen, spelled out: a formatter writes the escape as the character. */
const SOFT_HYPHEN = String.fromCodePoint(0xad);

/** Intact document words and section markers recognized by the shared vocabulary. */
const typographyWords = (lines: readonly MarkupLine[]) => {
  const words = new Set<string>();
  const spacedWords = new Set<string>();
  for (const { text } of lines) {
    for (const [word] of text.matchAll(/\p{L}[\p{L}\p{M}]*/gu)) {
      words.add(normalizeUnicode(word, "NFC").toLowerCase());
    }
    const colon = text.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const chunks = text
      .slice(0, colon + 1)
      .trim()
      .split(/\s+/u);
    let marker = "";
    for (const chunk of chunks.toReversed()) {
      marker = `${chunk} ${marker}`.trim();
      if (
        isSkHoldingMarker(marker) ||
        isSkReasoningMarker(marker) ||
        isSkStandaloneInstructionMarker(marker)
      ) {
        spacedWords.add(
          normalizeUnicode(
            marker.replaceAll(/[\s:]/gu, ""),
            "NFC",
          ).toLowerCase(),
        );
        break;
      }
    }
  }
  return { attestedWords: words, spacedWords };
};

/**
 * The court's typography read as the characters it prints.
 *
 * Letter-spaced emphasis (`n i e   j e   v súlade`, `O d ô v o d n e n i e :`)
 * is read as its words; see `letter-spacing.ts`, and its `setApart` rule for
 * the short words this court spaces on their own.
 *
 * The court's files encode the hyphen as U+00AD, the soft hyphen
 * (`PL. ÚS 10/2014<U+00AD>78`, `C<U+00AD>293/12`, `peer<U+00AD>to<U+00AD>peer`),
 * and the markup keeps it. A soft hyphen is invisible where a line does not
 * break, so the docket would read `10/201478`; every one these files print
 * is a visible hyphen, the ones at a line's end included (`obrazovo<U+00AD>`
 * / `zvukových`, `C<U+00AD>` / `293/12`).
 */
const readTypography = (
  inlines: readonly Inline[],
  evidence: ReturnType<typeof typographyWords>,
): Inline[] =>
  rewriteInlineWhitespace(
    mapInlineText(inlines, (text) => text.replaceAll(SOFT_HYPHEN, "-")),
    // Over the whole line: a wrapper's edge is not a gap between words.
    (text) => collapseLetterSpacing(text, { setApart: true, ...evidence }),
  );

type Section = SkDocumentSection;

const headingBlock = ({
  id,
  anchorId,
  level,
  line,
}: {
  id: string;
  anchorId: string;
  level: HeadingBlock["level"];
  line: MarkupLine;
}): Block => ({
  id,
  anchorId,
  type: "heading",
  level,
  ...(level === 1 ? { role: "decision-title" as const } : {}),
  ...(level === 2 ? { role: "section-heading" as const } : {}),
  inlines: line.inlines,
  plainText: line.text,
});

/**
 * A line that ends in a hyphen glued to its last word (`analyticko-`,
 * `C-`) continues that word on the next line: a compound or a docket the
 * line broke after its hyphen, never two words. A hyphen after a comma is
 * an amount's dash (`256,-` / `Sk`) and keeps its space.
 */
const ENDS_IN_GLUED_HYPHEN = /[\p{L}\d]-$/u;

/** Two consecutive lines of one paragraph as one line. */
const joinLines = (above: MarkupLine, below: MarkupLine): MarkupLine => {
  const glued =
    ENDS_IN_GLUED_HYPHEN.test(above.text) && /^\S/u.test(below.text);
  const separator: Inline[] = glued ? [] : [{ type: "text", text: " " }];
  return {
    inlines: [...above.inlines, ...separator, ...below.inlines],
    text: `${above.text}${glued ? "" : " "}${below.text}`,
    fontSize: Math.max(above.fontSize, below.fontSize),
  };
};

/**
 * A titled part of a part, numbered from its Roman numeral: `II.1.
 * Stanovisko národnej rady:`, `III.2.1. Rekodifikácia:`, `III.1 Podstata
 * problému …`. A cited docket (`III. ÚS 70/01`) has a space after the
 * numeral, so it is never one.
 */
const OUTLINE_HEADING_RE =
  /^(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3})(?:\.\d{1,2})+\.?\s+\p{L}/u;

/** A title is a line or a few, never a paragraph. */
const TITLE_LIMITS = { maxLines: 4, maxChars: 250, maxPartChars: 160 } as const;

/** Punctuation a title does not end with: it ends a sentence or a clause. */
const ENDS_PROSE = /[.,;:][“”"»)]*$/u;

/** A holding marker that shares its line with the holding's first words. */
const HOLDING_MARKER_PREFIX = /^(?:rozhodol|rozhodla|rozhodlo)\s?:\s*(?=\S)/u;

/**
 * The lines from `from` that one title spans, or `undefined` when they are
 * prose.
 *
 * A title runs until a blank line, a numbered paragraph or another part
 * opens; an outline title (`II.1.`) also until it ends with its colon. It is
 * a few lines at most, and an unnumbered title (the words under `I.`) ends
 * without the punctuation that ends a sentence or introduces one.
 */
const titleEnd = (
  lines: readonly MarkupLine[],
  openings: readonly (number | undefined)[],
  from: number,
  kind: "outline" | "part",
): number | undefined => {
  let end = from;
  let chars = 0;
  let titleLines = 0;
  let last = "";
  while (end < lines.length) {
    const text = lines[end]?.text ?? "";
    if (PAGE_NUMBER_PATTERN.test(text)) {
      end += 1;
      continue;
    }
    const opensSomethingElse =
      end > from &&
      (openings[end] !== undefined ||
        OUTLINE_HEADING_RE.test(text) ||
        endsReasoningPart(text));
    if (text.length === 0 || opensSomethingElse) {
      break;
    }
    chars += text.length + 1;
    titleLines += 1;
    last = text;
    end += 1;
    if (kind === "outline" && text.endsWith(":")) {
      break;
    }
    if (titleLines > TITLE_LIMITS.maxLines || chars > TITLE_LIMITS.maxChars) {
      return undefined;
    }
  }
  if (titleLines === 0) {
    return undefined;
  }
  if (kind === "outline") {
    return end;
  }
  // A part title ends with its line; at the foot of a page, the next page
  // must not go on with the sentence (`… v znení` / `neskorších …`).
  const next = nextTextLine(lines, end);
  const cutByPage =
    lines[end]?.pageBreak === true && /^\p{Ll}/u.test(next?.text ?? "");
  return ENDS_PROSE.test(last) || cutByPage || chars > TITLE_LIMITS.maxPartChars
    ? undefined
    : end;
};

/**
 * The first line from `from` that carries text: past blank lines, and past
 * a page number on a line of its own, which the classifier drops.
 */
const nextTextLine = (
  lines: readonly MarkupLine[],
  from: number,
): MarkupLine | undefined =>
  lines
    .slice(from)
    .find(({ text }) => text.length > 0 && !PAGE_NUMBER_PATTERN.test(text));

/** The lines `from` to `to` (exclusive) as one line. */
const joinRange = (
  lines: readonly MarkupLine[],
  from: number,
  to: number,
): MarkupLine | undefined => {
  let joined: MarkupLine | undefined;
  for (const line of lines.slice(from, to)) {
    if (PAGE_NUMBER_PATTERN.test(line.text)) {
      continue;
    }
    joined = joined === undefined ? line : joinLines(joined, line);
  }
  return joined;
};

/** A line opening with a number that numbers it: `4.`, `28.1.`. */
const NUMBERED_LINE = /^\d{1,3}(?:\.\d{1,3})*\.\s/u;

/**
 * Whether a paragraph open at the foot of a page goes on at the top of the
 * next one: the page broke a sentence (the next page opens with a lowercase
 * word, or with a number that numbers nothing, as in `zákona č.` /
 * `480/2002 Z. z.`), or the paragraph stopped where no sentence stops and
 * the next page opens neither a numbered paragraph nor a part of the
 * decision.
 */
const continuesOnNextPage = (open: string, next: string): boolean =>
  /^\p{Ll}/u.test(next) ||
  (/^\d/u.test(next) && !NUMBERED_LINE.test(next)) ||
  (!/[.!?:;][“”"»)]*$/u.test(open) &&
    !NUMBERED_LINE.test(next) &&
    openingNumberOf(next) === undefined &&
    !OUTLINE_HEADING_RE.test(next) &&
    !endsReasoningPart(next));

/** The blocks read so far, the paragraph still open, and where the reading is. */
type BlockBuilder = {
  readonly blocks: Block[];
  readonly makeAnchor: ReturnType<typeof createBlockAnchorAllocator>;
  section: Section;
  blockCount: number;
  paragraph: MarkupLine | null;
  /** The court's paragraph number the next numbered paragraph should carry. */
  nextCourtNumber: number;
};

const nextBlockId = (builder: BlockBuilder): string =>
  `b${builder.blocks.length + 1}`;

const flushParagraph = (builder: BlockBuilder): void => {
  const line = builder.paragraph;
  if (line === null) {
    return;
  }
  builder.paragraph = null;
  builder.blockCount += 1;
  const role = ((): "holding" | "intro" | "signature" | null => {
    if (builder.section === "closing") {
      return "signature";
    }
    if (builder.section === "holding") {
      return "holding";
    }
    return builder.section === "preamble" && builder.blocks.length <= 1
      ? "intro"
      : null;
  })();
  builder.blocks.push({
    id: nextBlockId(builder),
    anchorId: builder.makeAnchor(`p${builder.blockCount}`),
    type: "paragraph",
    ...(role === null ? {} : { role }),
    inlines: line.inlines,
    plainText: line.text,
  });
};

const openParagraph = (builder: BlockBuilder, line: MarkupLine): void => {
  builder.paragraph =
    builder.paragraph === null
      ? { ...line, inlines: [...line.inlines] }
      : joinLines(builder.paragraph, line);
};

const pushHeading = (
  builder: BlockBuilder,
  line: MarkupLine,
  level: HeadingBlock["level"],
  anchorId = `h${builder.blocks.length + 1}`,
): void => {
  builder.blocks.push(
    headingBlock({
      id: nextBlockId(builder),
      anchorId: builder.makeAnchor(anchorId),
      level,
      line,
    }),
  );
};

/** Open a section of the decision under its marker heading. */
const openSection = (
  builder: BlockBuilder,
  section: "holding" | "reasoning",
  marker: MarkupLine,
): void => {
  flushParagraph(builder);
  builder.section = section;
  builder.nextCourtNumber = 1;
  pushHeading(builder, marker, 2, `h-${section}`);
};

/** What one step of the reading needs: the lines, and each one's number. */
type Reading = {
  readonly lines: readonly MarkupLine[];
  readonly openings: readonly (number | undefined)[];
};

/**
 * A blank line ends the open paragraph, unless it is the break between two
 * pages inside a paragraph the page cut.
 */
const readBlankLine = (
  builder: BlockBuilder,
  { lines }: Reading,
  index: number,
): void => {
  const open = builder.paragraph?.text;
  const next = nextTextLine(lines, index + 1)?.text;
  if (
    lines[index]?.pageBreak === true &&
    open !== undefined &&
    next !== undefined &&
    continuesOnNextPage(open, next)
  ) {
    return;
  }
  flushParagraph(builder);
};

/**
 * The decision's title and the markers that open its parts, read in the
 * order a decision prints them. Whether the line was one.
 */
const readPartMarker = (builder: BlockBuilder, line: MarkupLine): boolean => {
  const { section } = builder;
  if (
    section === "preamble" &&
    (line.fontSize > TITLE_FONT_SIZE || isSkDecisionTitle(line.text))
  ) {
    flushParagraph(builder);
    const previous = builder.blocks.at(-1);
    if (previous?.type === "heading" && previous.role === "decision-title") {
      const joined = joinLines(
        {
          inlines: previous.inlines,
          text: previous.plainText,
          fontSize: line.fontSize,
        },
        line,
      );
      previous.inlines = joined.inlines;
      previous.plainText = joined.text;
      return true;
    }
    pushHeading(builder, line, 1, "h-title");
    return true;
  }
  // The holding precedes the reasoning; a `takto rozhodol:` inside the
  // reasoning closes a quoted petit, and the parts after it are still the
  // reasoning's.
  if (section === "preamble" || section === "holding") {
    // `r o z h o d o l : 1. Ustanovenie …`: the marker and the holding's
    // first words on one line.
    const shared =
      section === "preamble" ? HOLDING_MARKER_PREFIX.exec(line.text) : null;
    if (shared !== null) {
      const marker = shared[0].trim();
      openSection(builder, "holding", {
        ...line,
        inlines: [{ type: "text", text: marker }],
        text: marker,
      });
      const rest: MarkupLine = { ...line };
      setInlines(rest, stripInlinePrefix(line.inlines, shared[0].length));
      openParagraph(builder, rest);
      return true;
    }
    if (isSkHoldingMarker(line.text)) {
      openSection(builder, "holding", line);
      return true;
    }
  }
  if (isSkReasoningMarker(line.text)) {
    openSection(builder, "reasoning", line);
    return true;
  }
  return readClosingMarker(builder, line);
};

/** The instruction, the place and date, and the judge's signature. */
const readClosingMarker = (
  builder: BlockBuilder,
  line: MarkupLine,
): boolean => {
  if (isSkInstructionMarker(line.text)) {
    flushParagraph(builder);
    builder.section = "instruction";
    if (isSkStandaloneInstructionMarker(line.text)) {
      pushHeading(builder, line, 2, "h-instruction");
    } else {
      openParagraph(builder, line);
      flushParagraph(builder);
    }
    return true;
  }
  if (builder.section !== "instruction") {
    return false;
  }
  if (SK_CLOSING_RE.test(line.text)) {
    flushParagraph(builder);
    builder.section = "closing";
    builder.blockCount += 1;
    builder.blocks.push({
      id: nextBlockId(builder),
      anchorId: builder.makeAnchor(`p${builder.blockCount}`),
      type: "paragraph",
      role: "closing",
      inlines: line.inlines,
      plainText: line.text,
    });
    return true;
  }
  if (SK_JUDGE_TITLE_RE.test(line.text)) {
    flushParagraph(builder);
    builder.section = "closing";
    openParagraph(builder, line);
    flushParagraph(builder);
    return true;
  }
  return false;
};

/**
 * A titled part of a part (`II.1. Stanovisko národnej rady:`), over the
 * lines its title spans. The index after it, when the line opens one.
 */
const readOutlineHeading = (
  builder: BlockBuilder,
  { lines, openings }: Reading,
  index: number,
): number | undefined => {
  const text = lines[index]?.text ?? "";
  if (builder.section !== "reasoning" || !OUTLINE_HEADING_RE.test(text)) {
    return undefined;
  }
  const end = titleEnd(lines, openings, index, "outline");
  const title = end === undefined ? undefined : joinRange(lines, index, end);
  if (end === undefined || title === undefined) {
    return undefined;
  }
  flushParagraph(builder);
  pushHeading(builder, title, 4);
  return end;
};

/**
 * A part's numeral (`I.`), with the title the court prints under it
 * (`Návrh na začatie konania`) when there is one. The index after it, when
 * the line opens a part.
 */
const readPartHeading = (
  builder: BlockBuilder,
  { lines, openings }: Reading,
  index: number,
): number | undefined => {
  const line = lines[index];
  const heading =
    line === undefined || !/^[IVX]/u.test(line.text)
      ? null
      : skSectionHeading(line.text, builder.section);
  if (line === undefined || heading === null) {
    return undefined;
  }
  // A numeral that opens a line a sentence wrapped onto (`… doručeným` /
  // `IV. senátu ústavného súdu …`) names a senate, not a part.
  const open = builder.paragraph?.text;
  if (
    !SK_ROMAN_DIVIDER_RE.test(line.text) &&
    open !== undefined &&
    !/[.!?:;][“”"»)]*$/u.test(open)
  ) {
    return undefined;
  }
  flushParagraph(builder);
  let titleFrom = index + 1;
  while (
    lines[titleFrom]?.text === "" ||
    PAGE_NUMBER_PATTERN.test(lines[titleFrom]?.text ?? "")
  ) {
    titleFrom += 1;
  }
  const first = lines[titleFrom]?.text ?? "";
  const end =
    builder.section === "reasoning" &&
    SK_ROMAN_DIVIDER_RE.test(line.text) &&
    openings[titleFrom] === undefined &&
    !OUTLINE_HEADING_RE.test(first) &&
    !endsReasoningPart(first)
      ? titleEnd(lines, openings, titleFrom, "part")
      : undefined;
  const title =
    end === undefined ? undefined : joinRange(lines, titleFrom, end);
  if (end === undefined || title === undefined) {
    pushHeading(builder, line, heading.level);
    return index + 1;
  }
  pushHeading(builder, joinLines(line, title), heading.level);
  return end;
};

/**
 * A line of a paragraph. The court's next paragraph number opening a line
 * ends the paragraph before it, because some decisions set no blank line
 * between numbered paragraphs, or between the numbered points of the
 * holding. Only when it is unambiguous: the number is the one that comes
 * next, or a forward skip the numbering itself allows, and stands before a
 * capital (a wrapped "1. februára" is not one); the open paragraph has
 * finished a sentence and is not inside a quotation („…“: a quoted petit
 * numbers its own points); and the court does not print the same number
 * again right after this one's list (then this one is a list item and the
 * later one the court's paragraph).
 */
const readParagraphLine = (
  builder: BlockBuilder,
  { lines, openings }: Reading,
  index: number,
): void => {
  const line = lines[index];
  if (line === undefined) {
    return;
  }
  const opening =
    builder.section === "reasoning" || builder.section === "holding"
      ? openings[index]
      : undefined;
  const step =
    opening === undefined ? undefined : opening - (builder.nextCourtNumber - 1);
  if (
    opening !== undefined &&
    step !== undefined &&
    step >= 1 &&
    step <= COURT_PARAGRAPH_NUMBERING_LIMITS.maxJump
  ) {
    const open = builder.paragraph?.text;
    if (
      open !== undefined &&
      SENTENCE_END.test(open) &&
      !insideQuotation(open) &&
      !courtRepeatsAfterList(lines, openings, index, opening)
    ) {
      flushParagraph(builder);
    }
    if (builder.paragraph === null) {
      builder.nextCourtNumber = opening + 1;
    }
  }
  openParagraph(builder, line);
};

/**
 * Group the lines into blocks.
 *
 * A paragraph runs until a blank line, a section marker or the end of the
 * document, which is the court's own layout rather than a guess about
 * where a sentence stops. The blank line between two pages is not one: a
 * paragraph the page broke goes on (see {@link continuesOnNextPage}).
 */
const classifyLines = (lines: readonly MarkupLine[]): Block[] => {
  const builder: BlockBuilder = {
    blocks: [],
    makeAnchor: createBlockAnchorAllocator(),
    section: "preamble",
    blockCount: 0,
    paragraph: null,
    nextCourtNumber: 1,
  };
  const reading: Reading = {
    lines,
    openings: lines.map(({ text }) => openingNumberOf(text)),
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || PAGE_NUMBER_PATTERN.test(line.text)) {
      index += 1;
      continue;
    }
    if (line.text.length === 0) {
      readBlankLine(builder, reading, index);
      index += 1;
      continue;
    }
    if (readPartMarker(builder, line)) {
      index += 1;
      continue;
    }
    const after =
      readOutlineHeading(builder, reading, index) ??
      readPartHeading(builder, reading, index);
    if (after !== undefined) {
      index = after;
      continue;
    }
    readParagraphLine(builder, reading, index);
    index += 1;
  }
  flushParagraph(builder);
  return builder.blocks;
};

/** Whether a line ends the reasoning or opens a part of it. */
const endsReasoningPart = (text: string): boolean =>
  isSkHoldingMarker(text) ||
  isSkReasoningMarker(text) ||
  isSkInstructionMarker(text) ||
  skSectionHeading(text, "reasoning") !== null;

/**
 * Whether the line at `from`, opening with `number`, is an item of a list
 * that the court's own paragraph `number` follows.
 *
 * Read the way the list would run: its items count on from `number`
 * (`number + 1`, `number + 2`, …) up to the court's paragraph with the same
 * number, which opens where a paragraph can open — after a finished
 * sentence, outside a „quotation“. The look stops at the first number that
 * continues neither, and at the end of the part of the reasoning: past
 * either, a repeat of `number` is a quotation or a list elsewhere in the
 * decision, and says nothing about this line.
 */
const courtRepeatsAfterList = (
  lines: readonly MarkupLine[],
  openings: readonly (number | undefined)[],
  from: number,
  number: number,
): boolean => {
  let listNext = number + 1;
  let previous = lines[from]?.text ?? "";
  let quoted = quotationDepth(previous);
  for (let index = from + 1; index < lines.length; index += 1) {
    const text = lines[index]?.text ?? "";
    if (text.length === 0 || PAGE_NUMBER_PATTERN.test(text)) {
      continue;
    }
    if (endsReasoningPart(text)) {
      return false;
    }
    const later = openings[index];
    if (later === number) {
      if (quoted <= 0 && SENTENCE_END.test(previous)) {
        return true;
      }
    } else if (later !== undefined) {
      if (later !== listNext) {
        return false;
      }
      listNext += 1;
    }
    quoted += quotationDepth(text);
    previous = text;
  }
  return false;
};

/** A line opening with a court paragraph number and a capitalised word. */
const COURT_PARAGRAPH_OPENING = /^(?<number>\d{1,3})\.\s+\p{Lu}/u;

/** The court paragraph number each line opens with, if any. */
const openingNumberOf = (text: string): number | undefined => {
  const raw = COURT_PARAGRAPH_OPENING.exec(text)?.groups?.["number"];
  return raw === undefined ? undefined : Number(raw);
};

/**
 * The end of a sentence: a full stop, question or exclamation mark, then any
 * closing quotes or brackets, then possibly the page number the court prints
 * at the foot of a page, set apart by at least two spaces. A colon, an
 * abbreviation's number ("ods. 1", "č. 2") or a lettered point ("písm. a)")
 * does not end one.
 */
const SENTENCE_END = /[.!?][“”"»)]*(?:\s{2,}\d{1,4})?\s*$/u;

/** Quotations the text opens („) less those it closes (“). */
const quotationDepth = (text: string): number =>
  text.split("„").length - text.split("“").length;

/** Whether the text has opened a „quotation“ it has not closed. */
const insideQuotation = (text: string): boolean => quotationDepth(text) > 0;

export type ParseSkUsDocumentOptions = {
  /** The XHTML the content endpoint served, base64-decoded. */
  xhtml: string;
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  documentUrl: string;
};

export type ParseSkUsDocumentResult = {
  documentAst: DocumentAst;
  fulltext: string;
};

/** The source system this court's markup is served by. */
const SK_US_SOURCE_SYSTEM = "ustavnysud.sk";

export const parseSkUsDocumentXhtml = ({
  xhtml,
  caseNumber,
  ecli,
  court,
  decisionDate,
  decisionType,
  documentUrl,
}: ParseSkUsDocumentOptions): ParseSkUsDocumentResult => {
  const $ = cheerio.load(xhtml);
  markHiddenRuns($);
  const lines = removePageFurniture(readMarkupLines($));
  const words = typographyWords(lines);
  for (const line of lines) {
    setInlines(line, readTypography(line.inlines, words));
  }
  const blocks = courtParagraphNumbers(classifyLines(lines), {
    parser: "sk-us",
    caseNumber,
    url: documentUrl,
  });

  const fulltext = blocks
    .map(({ plainText }) => plainText)
    .filter((text) => text.length > 0)
    .join("\n\n");

  return {
    documentAst: {
      version: 1,
      source: {
        system: SK_US_SOURCE_SYSTEM,
        documentId: caseNumber,
        webUrl: documentUrl,
        printUrl: "",
      },
      metadata: {
        caseNumber,
        ecli: ecli ?? null,
        court,
        decisionDate: decisionDate ?? null,
        decisionType: decisionType ?? null,
        keywords: [],
        statutes: [],
      },
      blocks,
    },
    fulltext,
  };
};
