// parser-output-unchanged: read only under the opt-in common-court markup, which the SAOS and portal adapters pass with their version bumps.
/**
 * The text of a Polish common court's document, as its editor meant it.
 *
 * SAOS's copy and the courts' portal carry the same document, written in the
 * courts' own editor, and both reach the Polish decision parser as HTML whose
 * whitespace the parser has already rendered as a browser would; each `<br>`
 * is still a line-break inline here. The markup says more than the text
 * does:
 *
 * - A manual line break can be a line wrap. Editors set one before a
 *   one-letter word so it never ends a line ("zawarli⏎z pozwanym"), or
 *   wherever a justified line ran out. Only a break with positive evidence of
 *   a wrap reads as a space: a full line stopping mid-phrase, and the same
 *   sentence going on after it. Names, addresses, signatures and operative
 *   points keep their lines.
 * - A soft hyphen (U+00AD) marks where a word may break and is not text.
 * - A no-break space already parts the words it stands between; a space
 *   beside it adds nothing.
 * - An article index is a superscript bound to the number before it
 *   ("art. 353¹"), so it holds no space and a space at its end is set after
 *   it.
 */

import { panic } from "better-result";

// parser-output-unchanged: imports the document AST from its package owner
import type { Inline } from "@stll/legal-ast/document-ast";
import { hasInlineChildren } from "@stll/legal-ast/document-ast";

import { appendTextInline } from "./shared-inlines";

// Built from code points: the characters are invisible in a regex literal.
const NO_BREAK_SPACE = String.fromCodePoint(0xa0);
const SOFT_HYPHEN = new RegExp(String.fromCodePoint(0xad), "gu");
const SPACE_BESIDE_NO_BREAK_SPACE = new RegExp(` ?${NO_BREAK_SPACE} ?`, "gu");

/**
 * Padding inside a line. A `\n` the rendered text keeps is a line's end (a
 * block's edge, a break `<pre>` preserves) and is never padding.
 */
const HORIZONTAL_WHITESPACE = /[ \t\r\f]+/gu;
const TRAILING_WHITESPACE = /[ \t\n\r\f]+$/u;

/**
 * Shorter than this, a line ended where the court ended it: a name, a line
 * of an address, a signature. A wrapped line ran the width of the page.
 */
const MIN_WRAPPED_LINE_LENGTH = 40;

/** A line a wrap cut short stops mid-phrase, never at . : ; ! or ?. */
const ENDS_MID_PHRASE = /[\p{L}\p{Nd},)”]$/u;

/** The same sentence going on: "z pozwanym", "10 czerwca", "§ 1", "(...)". */
const SENTENCE_CONTINUATION = /^[\p{Ll}\p{Nd}§(„]/u;

/** A point's own number or letter: "1.", "2)", "(3)", "1.1.", "a)". */
const ENUMERATION_ITEM = /^\(?(?:\d{1,3}(?:\.\d{1,3})*|\p{Ll})[.)](?:\s|$)/u;

/** An operative point opens with its verb: "oddala apelację". */
const OPERATIVE_POINT =
  /^(?:oddala|zmienia|uchyla|zasądza|stwierdza|umarza|utrzymuje|nakazuje|odrzuca|ustala|przyznaje|zwraca|przekazuje|obciąża|nie obciąża|znosi|orzeka|uznaje|wymierza|zwalnia|zakazuje|postanawia)\b/iu;

/** The postal code of an address line: "00-001 Warszawa". */
const POSTAL_CODE = /^\d{2}-\d{3}\b/u;

/**
 * A judge's or the bench's title as the composition and signatures print
 * it: "SSA Anna Nowak", "Sędzia SO Jan Kowalski", "Przewodniczący:".
 */
const BENCH_TITLE =
  /(?:^|[\s,;:(])(?:SSA|SSO|SSR|SSN|SA|SO|SR|SN|del\.|Sędzi(?:a|owie)|Przewodnicząc[ya]|Protokolant(?:ka)?|Ławni(?:k|cy|czka)|Prokurator|Referendarz)(?=[\s:,.]|$)/u;

/** A line naming a role in the bench: "sędzia sprawozdawca", "Protokolant". */
const BENCH_ROLE =
  /^(?:sędzi(?:a|owie)|sprawozdawca|przewodnicząc[ya]|protokolant(?:ka)?|ławni(?:k|cy|czka)|referendarz|prokurator)\b/iu;

/**
 * Whether a line break between `before` and `after` only wraps a sentence.
 * The bench's composition and its signatures are lines of names and titles,
 * however long, so a line holding a judge's title, or a line opening with a
 * role in the bench, keeps its break.
 */
const isLineWrap = (before: string, after: string): boolean => {
  // A `\n` left in the text ends a line too (a block's edge, a kept break):
  // only the line the `<br>` itself ends, and the one it opens, are read.
  const previous = (before.split("\n").at(-1) ?? "").trim();
  const next = (after.split("\n").at(0) ?? "").trimStart();
  return (
    previous.length >= MIN_WRAPPED_LINE_LENGTH &&
    ENDS_MID_PHRASE.test(previous) &&
    !BENCH_TITLE.test(previous) &&
    SENTENCE_CONTINUATION.test(next) &&
    !ENUMERATION_ITEM.test(next) &&
    !OPERATIVE_POINT.test(next) &&
    !POSTAL_CODE.test(next) &&
    !BENCH_ROLE.test(next)
  );
};

/** The text between consecutive line breaks, in document order. */
const lineTexts = (inlines: readonly Inline[]): string[] => {
  const lines = [""];
  const walk = (run: readonly Inline[]): void => {
    for (const inline of run) {
      if (inline.type === "text") {
        lines[lines.length - 1] += inline.text;
      } else if (inline.type === "line-break") {
        lines.push("");
      } else if (hasInlineChildren(inline)) {
        walk(inline.children);
      }
    }
  };
  walk(inlines);
  return lines;
};

const softenLineWraps = (inlines: readonly Inline[]): Inline[] => {
  const lines = lineTexts(inlines);
  let breakIndex = 0;
  let endsWithSpace = true;
  const rebuild = (run: readonly Inline[]): Inline[] => {
    const out: Inline[] = [];
    for (const inline of run) {
      switch (inline.type) {
        case "text": {
          appendTextInline(out, inline.text, inline.anonymized === true);
          endsWithSpace = /\s$/u.test(inline.text);
          break;
        }
        case "line-break": {
          const wrap = isLineWrap(
            lines[breakIndex] ?? panic("Missing line before a break"),
            lines[breakIndex + 1] ?? panic("Missing line after a break"),
          );
          breakIndex += 1;
          if (!wrap) {
            out.push(inline);
          } else if (!endsWithSpace) {
            appendTextInline(out, " ");
          }
          endsWithSpace = true;
          break;
        }
        case "page-anchor": {
          out.push(inline);
          break;
        }
        case "bold":
        case "italic":
        case "underline":
        case "superscript":
        case "subscript":
        case "link":
        case "citation": {
          out.push({ ...inline, children: rebuild(inline.children) });
          break;
        }
        default: {
          inline satisfies never;
          panic(`Unhandled inline: ${String(inline)}`);
        }
      }
    }
    return out;
  };
  return rebuild(inlines);
};

/**
 * The text as typed: no soft hyphens, no space beside a no-break space, and
 * no space inside an article index.
 */
const typedText = (inlines: readonly Inline[], inIndex = false): Inline[] =>
  inlines.flatMap((inline): Inline[] => {
    if (inline.type === "text") {
      const typed = inline.text
        .replace(SOFT_HYPHEN, "")
        .replace(SPACE_BESIDE_NO_BREAK_SPACE, () => NO_BREAK_SPACE);
      const text = inIndex ? typed.replace(HORIZONTAL_WHITESPACE, "") : typed;
      return text === "" ? [] : [{ ...inline, text }];
    }
    if (!hasInlineChildren(inline)) {
      return [inline];
    }
    const children = typedText(
      inline.children,
      inIndex || inline.type === "superscript",
    );
    return children.length === 0 ? [] : [{ ...inline, children }];
  });

/**
 * Whitespace at the end of an article index, set after it instead: "385¹ §
 * 1", not "385¹§ 1". Padding at its start is dropped by `typedText`. What
 * ends the index is owed to the next text in document order: a space, paid
 * only where that text does not already open with whitespace, or the end of a
 * line (`\n`, a block's edge or a preserved break), always kept, so a
 * paragraph that ends in an index still ends there. A `<br>` cancels a space
 * it already parts.
 */
const withSpaceAfterIndices = (inlines: readonly Inline[]): Inline[] => {
  let owed = "";
  const rebuild = (run: readonly Inline[], inIndex: boolean): Inline[] => {
    const out: Inline[] = [];
    for (const inline of run) {
      if (inline.type === "text") {
        if (inIndex) {
          // Whitespace an earlier text of the same index ended with is inside
          // the index after all: its line ends stay where they were.
          const source = owed.includes("\n")
            ? `${owed}${inline.text}`
            : inline.text;
          const trailing = TRAILING_WHITESPACE.exec(source)?.at(0) ?? "";
          const breaks = trailing.replaceAll(/[^\n]/gu, "");
          if (breaks !== "") {
            owed = breaks;
          } else {
            owed = trailing === "" ? "" : " ";
          }
          appendTextInline(
            out,
            source.slice(0, source.length - trailing.length),
            inline.anonymized === true,
          );
          continue;
        }
        const pay =
          owed.includes("\n") || (owed !== "" && !/^\s/u.test(inline.text));
        const text = pay ? `${owed}${inline.text}` : inline.text;
        owed = "";
        appendTextInline(out, text, inline.anonymized === true);
        continue;
      }
      if (inline.type === "line-break") {
        if (owed.includes("\n")) {
          appendTextInline(out, owed);
        }
        owed = "";
        out.push(inline);
        continue;
      }
      if (!hasInlineChildren(inline)) {
        out.push(inline);
        continue;
      }
      const children = rebuild(
        inline.children,
        inIndex || inline.type === "superscript",
      );
      if (children.length > 0) {
        out.push({ ...inline, children });
      }
    }
    return out;
  };
  const out = rebuild(inlines, false);
  if (owed.includes("\n")) {
    appendTextInline(out, owed);
  }
  return out;
};

/** One inline run of a common court's document, read as its editor set it. */
export const readCommonCourtInlines = (inlines: readonly Inline[]): Inline[] =>
  softenLineWraps(typedText(withSpaceAfterIndices(inlines)));
