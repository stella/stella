import { panic, Result, TaggedError } from "better-result";

/**
 * Structural tokens that ride through the anonymization pipeline: the
 * delimiter that joins several fields into one pipeline call, and the
 * stand-ins that keep already-issued placeholders out of detection.
 *
 * Several text fields are anonymized in one call so an entity keeps one
 * placeholder across all of them and a name seen in one field is still
 * recognized when it recurs in another. The fields are joined with a
 * delimiter and split again afterwards, so the delimiter has to survive the
 * pipeline unchanged.
 *
 * Every token is built so no recognizer can match it:
 *
 * - it is a single private-use code point. That is not a letter, digit,
 *   punctuation or symbol in any script, so name, organization, identifier,
 *   number and email recognizers have nothing to match;
 * - it occurs in none of the inputs, so no field can contain or imitate it;
 *   the field delimiter also avoids the exact values the pipeline searches
 *   for (gazetteer entries, forced values), so no dictionary match can
 *   either;
 * - the field delimiter adds line breaks on both sides, which end any
 *   token-based or line-based match before it reaches the delimiter.
 *
 * The output is still checked: every token must come back exactly as often as
 * it went in. Anything else is refused with
 * {@link AnonymizedFieldBoundaryError}, and callers fail closed, so text whose
 * structure did not survive is never forwarded.
 */

/**
 * Private-use planes reserved for structural tokens that ride through the
 * anonymization pipeline. Each layer owns one plane so the tokens of one
 * layer can never be mistaken for another's.
 */
export const RESERVED_TOKEN_PLANE = {
  /** Supplementary Private Use Area-A: field delimiters. */
  fieldDelimiter: { end: 0xf_ff_fd, start: 0xf_00_00 },
  /** Supplementary Private Use Area-B: protected placeholders. */
  protectedPlaceholder: { end: 0x10_ff_fd, start: 0x10_00_00 },
} as const;

type ReservedTokenPlane =
  (typeof RESERVED_TOKEN_PLANE)[keyof typeof RESERVED_TOKEN_PLANE];

const DELIMITER_EDGE = "\n";

export class AnonymizedFieldBoundaryError extends TaggedError(
  "AnonymizedFieldBoundaryError",
)<{ message: string }> {}

export type JoinedAnonymizationFields = {
  /** The single text handed to the anonymization pipeline. */
  text: string;
  /** Recover the fields, in order, from the pipeline's output for `text`. */
  split: (
    redactedText: string,
  ) => Result<string[], AnonymizedFieldBoundaryError>;
};

const collectPlaneCodePoints = (
  plane: ReservedTokenPlane,
  texts: Iterable<string>,
): Set<number> => {
  const used = new Set<number>();
  for (const text of texts) {
    for (const character of text) {
      const codePoint = character.codePointAt(0);
      if (
        codePoint !== undefined &&
        codePoint >= plane.start &&
        codePoint <= plane.end
      ) {
        used.add(codePoint);
      }
    }
  }
  return used;
};

/**
 * Allocate `count` distinct single-code-point tokens from `plane`, none of
 * which occurs in `texts`. A token is one private-use code point: no
 * recognizer matches it, and no input can contain or imitate it.
 */
const allocateReservedTokens = ({
  count,
  plane,
  texts,
}: {
  count: number;
  plane: ReservedTokenPlane;
  texts: Iterable<string>;
}): Result<string[], AnonymizedFieldBoundaryError> => {
  const used = collectPlaneCodePoints(plane, texts);
  const tokens: string[] = [];
  for (
    let codePoint = plane.start;
    codePoint <= plane.end && tokens.length < count;
    codePoint += 1
  ) {
    if (!used.has(codePoint)) {
      tokens.push(String.fromCodePoint(codePoint));
    }
  }
  if (tokens.length < count) {
    return Result.err(
      new AnonymizedFieldBoundaryError({
        message: "Not enough free reserved tokens for this input",
      }),
    );
  }
  return Result.ok(tokens);
};

/**
 * Count each of `tokens` in `text`. Two texts carry the same tokens exactly
 * when their counts are equal.
 */
const countReservedTokens = (
  text: string,
  tokens: ReadonlySet<string>,
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const character of text) {
    if (tokens.has(character)) {
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }
  }
  return counts;
};

const haveSameReservedTokens = (
  before: string,
  after: string,
  tokens: ReadonlySet<string>,
): boolean => {
  const expected = countReservedTokens(before, tokens);
  const actual = countReservedTokens(after, tokens);
  return (
    expected.size === actual.size &&
    [...expected].every(([token, count]) => actual.get(token) === count)
  );
};

/**
 * Join `fields` into one text for a single anonymization pass.
 *
 * `reservedValues` are the exact strings the pipeline will search for besides
 * its built-in recognizers (gazetteer canonicals and variants, forced
 * values); the delimiter avoids every code point they contain.
 */
export const joinFieldsForAnonymization = ({
  fields,
  reservedValues = [],
}: {
  fields: readonly string[];
  reservedValues?: Iterable<string> | undefined;
}): Result<JoinedAnonymizationFields, AnonymizedFieldBoundaryError> => {
  const token = allocateReservedTokens({
    count: 1,
    plane: RESERVED_TOKEN_PLANE.fieldDelimiter,
    texts: [...fields, ...reservedValues],
  });
  if (Result.isError(token)) {
    return Result.err(token.error);
  }

  const delimiterTokens = new Set(token.value);
  const separator = `${DELIMITER_EDGE}${token.value.join("")}${DELIMITER_EDGE}`;
  const text = fields.map((field) => `${separator}${field}`).join("");
  return Result.ok({
    text,
    split: (redactedText) => {
      const parts = redactedText.split(separator);
      // Equal token counts rule out a delimiter that lost only its edges;
      // the part count and the empty leading part rule out a lost edge.
      if (
        parts.length !== fields.length + 1 ||
        parts[0] !== "" ||
        !haveSameReservedTokens(text, redactedText, delimiterTokens)
      ) {
        return Result.err(
          new AnonymizedFieldBoundaryError({
            message: `Anonymized text kept ${String(parts.length - 1)} of ${String(fields.length)} field delimiters`,
          }),
        );
      }
      return Result.ok(parts.slice(1));
    },
  });
};

export type ProtectedAnonymizationFields = {
  /** The fields with every protected value replaced by its token. */
  fields: string[];
  /** Put the protected values back into the pipeline's output fields. */
  restore: (
    redactedFields: readonly string[],
  ) => Result<string[], AnonymizedFieldBoundaryError>;
};

const escapeRegExp = (value: string) =>
  value.replaceAll(/[$()*+.?[\\\]^{|}]/gu, "\\$&");

const replaceExactValues = (
  text: string,
  replacements: ReadonlyMap<string, string>,
): string => {
  if (replacements.size === 0) {
    return text;
  }
  const pattern = new RegExp(
    [...replacements.keys()]
      .toSorted((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join("|"),
    "gu",
  );
  return text.replaceAll(pattern, (value) => replacements.get(value) ?? value);
};

/**
 * Hide exact `values` (for example placeholders issued earlier) from the
 * pipeline by replacing each with a reserved token, and put them back
 * afterwards. A field whose tokens did not all come back is refused.
 */
export const protectValuesForAnonymization = ({
  fields,
  values,
}: {
  fields: readonly string[];
  values: readonly string[];
}): Result<ProtectedAnonymizationFields, AnonymizedFieldBoundaryError> => {
  const distinctValues = [...new Set(values)].filter(
    (value) => value.length > 0,
  );
  const tokens = allocateReservedTokens({
    count: distinctValues.length,
    plane: RESERVED_TOKEN_PLANE.protectedPlaceholder,
    texts: fields,
  });
  if (Result.isError(tokens)) {
    return Result.err(tokens.error);
  }

  const protect = new Map<string, string>();
  const restore = new Map<string, string>();
  for (const [index, value] of distinctValues.entries()) {
    const token = tokens.value[index] ?? panic("Missing reserved token");
    protect.set(value, token);
    restore.set(token, value);
  }
  const tokenSet = new Set(restore.keys());
  const protectedFields = fields.map((field) =>
    replaceExactValues(field, protect),
  );

  return Result.ok({
    fields: protectedFields,
    restore: (redactedFields) => {
      const intact =
        redactedFields.length === protectedFields.length &&
        redactedFields.every((field, index) =>
          haveSameReservedTokens(protectedFields[index] ?? "", field, tokenSet),
        );
      if (!intact) {
        return Result.err(
          new AnonymizedFieldBoundaryError({
            message: "Anonymized text did not keep every protected value",
          }),
        );
      }
      return Result.ok(
        redactedFields.map((field) => replaceExactValues(field, restore)),
      );
    },
  });
};
