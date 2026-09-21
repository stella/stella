/**
 * A style guide: what each style in a style set is for, in words.
 *
 * The catalogue says what a style looks like; the guide says when a drafter
 * reaches for it. That judgement is prose, so it is written once per style
 * set and stored with it rather than derived per conversion. Conversion
 * reads the guide to gloss the options it puts to the decision model, which
 * is why a guide entry naming a style the set does not have is refused at
 * the boundary instead of surfacing as an option nothing can apply.
 *
 * `catalogueHash` binds a guide to the catalogue it was written against, so
 * a replaced style-set file leaves the guide visibly stale rather than
 * silently describing styles that are gone.
 */

import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { StyleCatalogue } from "@/api/lib/house-style/catalogue";

export class StyleGuideError extends TaggedError("StyleGuideError")<{
  message: string;
  /** Guide entries naming a style the catalogue does not carry. */
  unknownStyleIds: string[];
}> {}

/** The guide was written against a different version of the style set's file. */
export class StyleGuideStaleError extends TaggedError("StyleGuideStaleError")<{
  message: string;
  writtenFor: string;
  catalogueHash: string;
}> {}

export const STYLE_GUIDE_STALE_MESSAGE =
  "The style guide was written against a different version of this style set";

const prose = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000));

/**
 * Snake_case keys: the entry travels into the decision model's state as it
 * is written, and the model reads the key names as part of the question.
 */
const styleGuideEntrySchema = v.strictObject({
  id: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256)),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256)),
  /** One line: what the style is for. Glosses the option in a question. */
  purpose: prose,
  use_when: prose,
  do_not_use_when: prose,
  /** Where the style sits: its parent style and its depth. */
  hierarchy: prose,
  /** How a reader recognizes it: numbering, weight, caps, indent. */
  looks_like: prose,
});

/**
 * What a caller authors. `catalogueHash` is optional because a guide can be
 * written before it is bound to anything; when it is there, binding refuses a
 * catalogue it does not name rather than applying a guide to another file.
 */
const styleGuideDraftSchema = v.strictObject({
  catalogueHash: v.optional(v.pipe(v.string(), v.minLength(1))),
  styles: v.pipe(v.array(styleGuideEntrySchema), v.minLength(1)),
});

export type StyleGuideDraft = v.InferOutput<typeof styleGuideDraftSchema>;

/** What a style set stores: the same entries, bound to a catalogue. */
const styleGuideSchema = v.strictObject({
  ...styleGuideDraftSchema.entries,
  catalogueHash: v.pipe(v.string(), v.minLength(1)),
});

export type StyleGuide = v.InferOutput<typeof styleGuideSchema>;

export const parseStyleGuideDraft = (
  input: unknown,
): Result<StyleGuideDraft, StyleGuideError> => {
  const parsed = v.safeParse(styleGuideDraftSchema, input);
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        new StyleGuideError({
          message: `The style guide does not match its shape: ${parsed.issues
            .map((issue) => issue.message)
            .join("; ")}`,
          unknownStyleIds: [],
        }),
      );
};

/**
 * A guide is only usable where every entry names a style the set actually
 * has: an option the rewrite cannot apply would be offered to the decision
 * model and then fail on the paragraph that chose it.
 */
export const bindStyleGuide = ({
  draft,
  catalogue,
}: {
  draft: StyleGuideDraft;
  catalogue: StyleCatalogue;
}): Result<StyleGuide, StyleGuideError | StyleGuideStaleError> => {
  if (
    draft.catalogueHash !== undefined &&
    draft.catalogueHash !== catalogue.hash
  ) {
    return Result.err(
      new StyleGuideStaleError({
        message: STYLE_GUIDE_STALE_MESSAGE,
        writtenFor: draft.catalogueHash,
        catalogueHash: catalogue.hash,
      }),
    );
  }
  const known = new Set(catalogue.styles.map(({ id }) => id));
  const unknownStyleIds = draft.styles
    .map(({ id }) => id)
    .filter((id) => !known.has(id));
  if (unknownStyleIds.length > 0) {
    return Result.err(
      new StyleGuideError({
        message: `The style guide names ${String(unknownStyleIds.length)} style(s) the style set does not carry`,
        unknownStyleIds,
      }),
    );
  }
  return Result.ok({ styles: draft.styles, catalogueHash: catalogue.hash });
};

/** Whether a stored guide still describes the style set's current file. */
export const isStyleGuideCurrent = (
  guide: StyleGuide,
  catalogue: StyleCatalogue,
): boolean => guide.catalogueHash === catalogue.hash;
