// Which REF field stands for a cross-reference, and what it will show.
//
// The field is written with its result cached, so the document reads right
// before Word updates anything; the engine refuses a cache that differs from
// what it predicts. `\n` shows the target's paragraph number without its
// closing period and is the one switch whose result does not depend on where
// the field stands. `\t` drops the words of a level text (`Čl. %1`), which
// the source already has in front of the designator.

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
  | "punctuated-words";

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
      // would keep, or the level is not cited at all.
      rendered += withoutWords && WORDS.test(part) ? "" : part;
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
