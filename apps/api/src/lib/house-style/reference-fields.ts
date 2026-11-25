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
  formatNumeral,
  labelFieldText,
  parseLabelShape,
} from "@/api/lib/house-style/designators";
import type { TemplateNumberingLevel } from "@/api/lib/house-style/folio-contract";

export const REFERENCE_FIELD_SWITCHES = {
  number: String.raw`\n \h`,
  numberWithoutWords: String.raw`\n \t \h`,
} as const;

export type ReferenceFieldNumbering =
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

export type ReferenceFieldRequest = {
  /** The designator as the source prints it: the span the field replaces,
   *  brackets included. */
  designatorText: string;
  /** Level text of the level that numbers the target in the output, after
   *  any numbering patch. */
  levelText: string;
  numbering: ReferenceFieldNumbering;
};

export type ReferenceField = {
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
  | "unrenderable-level";

export class ReferenceFieldError extends TaggedError("ReferenceFieldError")<{
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
const CLOSING_PERIODS = /[.\s]+$/u;

const literalsOf = (levelText: string): string[] =>
  levelText.split(PLACEHOLDER).filter((part) => !PLACEHOLDER.test(part));

const hasWords = (levelText: string): boolean =>
  literalsOf(levelText).some((literal) => WORDS.test(literal));

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
      rendered += withoutWords && WORDS.test(part) ? "" : part;
      continue;
    }
    const ilvl = Number(part.slice(1)) - 1;
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
  return rendered.trim().replace(CLOSING_PERIODS, "");
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
      return Result.ok({
        instruction:
          hasWords(levelText) || shape.keyword !== null
            ? REFERENCE_FIELD_SWITCHES.numberWithoutWords
            : REFERENCE_FIELD_SWITCHES.number,
        expectedText,
        text: "kept",
      });
    }
    case "houseScheme": {
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
