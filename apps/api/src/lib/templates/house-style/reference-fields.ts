// Which REF field stands for a cross-reference, and what it will show.
//
// The field is written with its result cached, so the document reads right
// before Word updates anything; the engine refuses a cache that differs from
// what it predicts. `\n` shows the target's paragraph number without its
// closing period and is the one switch whose result does not depend on where
// the field stands. `\t` drops the words of a level text (`Čl. %1`), which
// the source already has in front of the designator.
//
// `\t` keeps the punctuation of the words it drops, so a level like `Čl. %1`
// has no field that shows the bare number. There the field stands for word
// and number together: `\n` prints the whole label, and a letter-case
// format gives it the citation's spelling (`čl. 3` for the label `Čl. 3`).

import { panic, Result, TaggedError } from "better-result";

import { declareFingerprintFields } from "@stll/errors";

import {
  digitsValue,
  formatNumeral,
  labelFieldText,
  parseLabelShape,
} from "@/api/lib/templates/house-style/designators";
import type { TemplateNumberingLevel } from "@/api/lib/templates/house-style/folio-contract";

export const REFERENCE_FIELD_SWITCHES = {
  number: String.raw`\n \h`,
  numberWithoutWords: String.raw`\n \t \h`,
} as const;

type ReferenceFieldNumbering =
  /** The output keeps the source's designators: the level text is patched
   *  to print what the source label prints. */
  | { mode: "keepSource"; sourceLabel: string }
  /** The output numbers in the template's scheme. `counters[n]` is the
   *  target's counter at level `n`, down to its own level. */
  | {
      mode: "houseScheme";
      levels: readonly TemplateNumberingLevel[];
      counters: readonly number[];
    };

type ReferenceFieldRequest = {
  /** The designator as the source prints it: the span the field replaces,
   *  brackets included. */
  designatorText: string;
  /** Level text of the level that numbers the target in the output, after
   *  any numbering patch. */
  levelText: string;
  numbering: ReferenceFieldNumbering;
};

type ReferenceField = {
  instruction: string;
  expectedText: string;
  /** `renumbered` when the field shows another designator than the source
   *  printed, which only the house scheme may do. */
  text: "kept" | "renumbered";
};

type ReferenceFieldErrorReason =
  /** The field would not show what the source says. */
  | "designator-mismatch"
  /** The source label is not a designator this reader knows. */
  | "unreadable-label"
  /** The level text names a level or a number format that cannot be
   *  rendered. */
  | "unrenderable-level"
  /** The words of the level text carry punctuation, which the field would
   *  show in front of the number. */
  | "punctuated-words"
  /** The citation spells the label's words in a letter case no format
   *  gives back, or a format would change the case of its numeral too. */
  | "case-not-reproducible"
  /** The blank between the citation's word and number is not the level
   *  text's: the field would replace a no-break space by a plain one, or
   *  the other way round. */
  | "blank-differs";

class ReferenceFieldError extends TaggedError("ReferenceFieldError")<{
  message: string;
  reason: ReferenceFieldErrorReason;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const fail = (reason: ReferenceFieldErrorReason, message: string) =>
  Result.err(new ReferenceFieldError({ reason, message }));

const PLACEHOLDER = /(%\d)/u;
/** Anything a level text carries besides counters and their delimiters. */
const WORDS = /[^\s\d.()[\]\-–—/:,;]/u;

/** Drops the periods and blanks a rendered label ends with. */
const withoutClosingPeriods = (rendered: string): string => {
  let end = rendered.length;
  while (end > 0 && /[.\s]/u.test(rendered.charAt(end - 1))) {
    end -= 1;
  }
  return rendered.slice(0, end);
};

const literalsOf = (levelText: string): string[] =>
  levelText.split(PLACEHOLDER).filter((part) => !PLACEHOLDER.test(part));

const hasWords = (levelText: string): boolean =>
  literalsOf(levelText).some((literal) => WORDS.test(literal));

/** What a field keeps when it drops the words around it: punctuation and
 *  brackets. */
const KEPT_WITH_WORDS = /[.\-–—/:,;()[\]]/u;

/**
 * Whether a field can show the bare number of a paragraph numbered by
 * `levelText`. `\t` drops the words of a level text and keeps what stands
 * between them: `Článek %1.` gives `II`, while `Příloha č. %1` gives `.2`,
 * the period of `č.` in front of the number. A level whose words carry
 * punctuation or a bracket therefore cannot be cited by a numbered field.
 */
export const showsBareNumber = (levelText: string): boolean =>
  literalsOf(levelText).every(
    (literal) => !WORDS.test(literal) || !KEPT_WITH_WORDS.test(literal),
  );

const renderLevelText = (
  levelText: string,
  {
    levels,
    counters,
  }: Extract<ReferenceFieldNumbering, { mode: "houseScheme" }>,
): string | null => {
  const withoutWords = hasWords(levelText);
  let rendered = "";
  for (const part of levelText.split(PLACEHOLDER)) {
    if (!PLACEHOLDER.test(part)) {
      // A literal with words is dropped whole: it holds nothing a field
      // would keep, or the level is not cited at all. Of the others the
      // field keeps the punctuation and drops the blanks: `Part %1 -`
      // gives `B-`.
      if (!withoutWords) {
        rendered += part;
      } else if (!WORDS.test(part)) {
        rendered += part.replaceAll(/\s+/gu, "");
      }
      continue;
    }
    // `%1` is level 0.
    const ilvl = (digitsValue(part.slice(1)) ?? 0) - 1;
    const counter = counters[ilvl];
    const numFmt = levels.find((level) => level.ilvl === ilvl)?.numFmt;
    const numeral =
      counter === undefined || numFmt === undefined
        ? null
        : formatNumeral(counter, numFmt);
    if (numeral === null) {
      return null;
    }
    rendered += numeral;
  }
  return withoutClosingPeriods(rendered.trimStart());
};

/**
 * Chooses the switches and predicts the result of the field that replaces
 * one designator. Letters and romans keep their brackets in the result, so
 * the span it replaces must carry them too.
 */
export const selectReferenceField = ({
  designatorText,
  levelText,
  numbering,
}: ReferenceFieldRequest): Result<ReferenceField, ReferenceFieldError> => {
  switch (numbering.mode) {
    case "keepSource": {
      const label = numbering.sourceLabel.trim();
      const shape = parseLabelShape(label);
      if (shape === null || shape.length !== label.length) {
        return fail("unreadable-label", "Source label is not a designator");
      }
      const expectedText = labelFieldText(shape);
      if (expectedText !== designatorText) {
        return fail(
          "designator-mismatch",
          "The reference does not print the designator of its target",
        );
      }
      const withoutWords = hasWords(levelText) || shape.keyword !== null;
      if (withoutWords && !showsBareNumber(levelText)) {
        return fail(
          "punctuated-words",
          "The field would show punctuation of the level's words",
        );
      }
      return Result.ok({
        instruction: withoutWords
          ? REFERENCE_FIELD_SWITCHES.numberWithoutWords
          : REFERENCE_FIELD_SWITCHES.number,
        expectedText,
        text: "kept",
      });
    }
    case "houseScheme": {
      if (!showsBareNumber(levelText)) {
        return fail(
          "punctuated-words",
          "The field would show punctuation of the level's words",
        );
      }
      const expectedText = renderLevelText(levelText, numbering);
      if (expectedText === null || expectedText === "") {
        return fail(
          "unrenderable-level",
          "The level text cannot be rendered with the given counters",
        );
      }
      return Result.ok({
        instruction: hasWords(levelText)
          ? REFERENCE_FIELD_SWITCHES.numberWithoutWords
          : REFERENCE_FIELD_SWITCHES.number,
        expectedText,
        text: expectedText === designatorText ? "kept" : "renumbered",
      });
    }
    default: {
      numbering satisfies never;
      return panic("Unhandled numbering");
    }
  }
};

type LabelFieldRequest = {
  /** Text of the block the citation stands in. */
  text: string;
  /** Span of the designator in it. */
  start: number;
  end: number;
  /** Level text of the level that numbers the target in the output. */
  levelText: string;
  /** The label the target prints in the output. */
  label: string;
};

type LabelField = ReferenceField & {
  /** Where the field starts: at the citation's word, in front of the
   *  designator. */
  start: number;
};

const CASE_FORMATS = [
  { switches: "", apply: (text: string): string => text },
  {
    switches: String.raw`\* lower `,
    apply: (text: string): string => text.toLowerCase(),
  },
  {
    switches: String.raw`\* Upper `,
    apply: (text: string): string => text.toUpperCase(),
  },
  {
    switches: String.raw`\* FirstCap `,
    apply: (text: string): string =>
      text.charAt(0).toUpperCase() + text.slice(1),
  },
] as const;

const BLANK = /[ \u00A0]/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The field that stands for a citation's word and number together, for a
 * target whose level prints words a number-only field cannot drop cleanly:
 * `čl. 3` citing the paragraph labelled `Čl. 3`. The field prints the whole
 * label, in the letter case the citation spells the word in.
 *
 * It fits only where the citation uses the label's own words: `článku 3`
 * stays text. A letter-case format changes the whole result, so a
 * lower-case citation of a roman number (`čl. IV`) stays text too, and so
 * does a citation whose blank is not the level text's.
 */
export const selectLabelField = ({
  text,
  start,
  end,
  levelText,
  label,
}: LabelFieldRequest): Result<LabelField, ReferenceFieldError> => {
  const shown = withoutClosingPeriods(label.trim());
  const words = levelText.slice(0, Math.max(0, levelText.indexOf("%")));
  if (!WORDS.test(words) || !shown.startsWith(words)) {
    return fail("unrenderable-level", "The label does not start with words");
  }
  const numeral = shown.slice(words.length);
  const wordStart = start - words.length;
  const cited = wordStart < 0 ? "" : text.slice(wordStart, start);
  const before = wordStart <= 0 ? "" : text.charAt(wordStart - 1);
  if (
    cited.replaceAll(BLANK, " ").toLowerCase() !==
      words.replaceAll(BLANK, " ").toLowerCase() ||
    LETTER_OR_DIGIT.test(before)
  ) {
    return fail(
      "punctuated-words",
      "The citation does not print the label's words",
    );
  }
  if (cited.toLowerCase() !== words.toLowerCase()) {
    return fail("blank-differs", "The citation's blank is not the label's");
  }
  const format = CASE_FORMATS.find(({ apply }) => apply(words) === cited);
  // The format applies to the whole result: it must leave the number as
  // the label prints it.
  if (format === undefined || format.apply(shown) !== `${cited}${numeral}`) {
    return fail(
      "case-not-reproducible",
      "No letter-case format prints the citation's spelling",
    );
  }
  return Result.ok({
    instruction: String.raw`\n ${format.switches}\h`,
    expectedText: `${cited}${numeral}`,
    start: wordStart,
    text: text.slice(start, end) === numeral ? "kept" : "renumbered",
  });
};
