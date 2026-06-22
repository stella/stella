import { useState } from "react";

/**
 * Resolve the `dir` for a free-text field so the caret and alignment follow
 * the ambient UI direction while the field is empty, then switch to the typed
 * content's own direction once the user starts writing.
 *
 * `dir="auto"` on its own is wrong for this: the bidi heuristic reads the
 * field's *value*, and an empty value has no strong directional character, so
 * it falls back to LTR — leaving the caret on the left even under an RTL UI.
 * Here an empty field omits `dir` entirely (so it inherits the document
 * direction: caret on the right in Arabic), and a non-empty field uses
 * `dir="auto"` (Arabic content → RTL, Latin content → LTR, re-evaluated live).
 *
 * An explicit `dir="ltr"`/`dir="rtl"` is treated as a forced direction and
 * returned unchanged (e.g. always-LTR numeric fields).
 *
 * Empty↔non-empty is the only transition that changes direction, so the
 * uncontrolled path stores a boolean and the state setter no-ops (no re-render)
 * on every keystroke that doesn't cross that boundary.
 */

type FieldValue = string | number | readonly string[] | undefined;

type UseContentDirArgs = {
  dir: string | undefined;
  value: FieldValue;
  defaultValue: FieldValue;
};

type UseContentDirResult = {
  dir: "ltr" | "rtl" | "auto" | undefined;
  /**
   * Feed the field's current text on every change so the uncontrolled path can
   * detect the empty↔non-empty transition. No-op for controlled fields, whose
   * direction is derived from `value` on render.
   */
  trackValue: (text: string) => void;
};

const hasText = (value: FieldValue): boolean => {
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (typeof value === "number") {
    return true;
  }
  // A multi-value field (readonly string[]) counts as content when non-empty.
  return Array.isArray(value) && value.length > 0;
};

/**
 * Content-derived direction for a controlled field value: `"auto"` when there
 * is content, `undefined` when empty (so the field inherits the ambient UI
 * direction — caret on the RTL side under Arabic). Use this for a raw
 * `<input>`/`<textarea>` whose value you already control; the shared
 * `<Input>`/`<Textarea>` apply it for you via `useContentDir`, which also
 * tracks the empty↔non-empty transition for uncontrolled fields.
 */
export const contentDir = (value: FieldValue): "auto" | undefined =>
  hasText(value) ? "auto" : undefined;

export const useContentDir = ({
  dir,
  value,
  defaultValue,
}: UseContentDirArgs): UseContentDirResult => {
  const forcedDir = dir === "ltr" || dir === "rtl" ? dir : undefined;
  const isControlled = value !== undefined;
  const [uncontrolledHasText, setUncontrolledHasText] = useState(() =>
    hasText(defaultValue),
  );
  const contentPresent = isControlled ? hasText(value) : uncontrolledHasText;

  return {
    dir: forcedDir ?? (contentPresent ? "auto" : undefined),
    trackValue: (text) => {
      if (isControlled) {
        return;
      }
      const next = text.length > 0;
      setUncontrolledHasText((previous) =>
        previous === next ? previous : next,
      );
    },
  };
};
