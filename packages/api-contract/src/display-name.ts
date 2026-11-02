import * as v from "valibot";

import { DEFAULT_VARCHAR_MAX_LENGTH } from "./limits";

/**
 * Explicit embeddings (U+202A, U+202B), overrides (U+202D, U+202E), their
 * terminator (U+202C) and isolates (U+2066..U+2069). Each one reorders the
 * text after it. The implicit marks U+200E and U+200F stay: they only set the
 * direction of the neutral characters beside them, which right-to-left names
 * can rely on.
 *
 * `@stll/ui` renders the same names and must build standalone, so it keeps
 * its own copy of this set; `directional-controls-parity.test.ts` in apps/web
 * holds the two equal for every code point.
 */
const DIRECTIONAL_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/gu;

/** Removes explicit directional formatting from text a person typed. */
export const stripDirectionalControls = (text: string): string =>
  text.replaceAll(DIRECTIONAL_CONTROLS, "");

type StripDirectionalControlsAction = v.BaseTransformation<
  string,
  string,
  never
> & {
  readonly type: "strip_directional_controls";
  readonly reference: typeof stripDirectionalControlsAction;
};

/**
 * A named transformation rather than `v.transform`: JSON Schema rendering in
 * input mode stops at a generic transform, which would hide the bounds that
 * follow it from every agent-facing schema.
 */
const stripDirectionalControlsAction = (): StripDirectionalControlsAction => ({
  kind: "transformation",
  type: "strip_directional_controls",
  reference: stripDirectionalControlsAction,
  async: false,
  "~run": (dataset) => ({
    ...dataset,
    value: stripDirectionalControls(dataset.value),
  }),
});

/**
 * The one step that drops explicit directional formatting from a typed name.
 * `displayNameSchema` is its only user; the census in
 * `apps/api/src/handlers/display-name-fields.census.test.ts` finds it by
 * identity in every request schema and tool input that names something.
 */
export const DISPLAY_NAME_NORMALIZER = stripDirectionalControlsAction();

/** The normalizer keeps the published string shape: a name is still a string. */
export const DISPLAY_NAME_RUNTIME_ONLY_ACTIONS = [
  DISPLAY_NAME_NORMALIZER,
] as const;

type DisplayNameOptions = {
  /** Upper bound after normalization; defaults to `DEFAULT_VARCHAR_MAX_LENGTH`. */
  maxLength?: number;
  /** An optional part of a name (a middle name) may be empty. */
  allowEmpty?: boolean;
};

/**
 * A name a person gives something: a matter, a contact, a view, a column, a
 * template. The value is stored without explicit directional formatting, so
 * no surface that shows it can be reordered by what was typed; implicit marks
 * and every letter stay. Bounds apply to the stored value.
 */
export const displayNameSchema = ({
  maxLength = DEFAULT_VARCHAR_MAX_LENGTH,
  allowEmpty = false,
}: DisplayNameOptions = {}) =>
  allowEmpty
    ? v.pipe(v.string(), DISPLAY_NAME_NORMALIZER, v.maxLength(maxLength))
    : v.pipe(
        v.string(),
        DISPLAY_NAME_NORMALIZER,
        v.minLength(1),
        v.maxLength(maxLength),
      );
