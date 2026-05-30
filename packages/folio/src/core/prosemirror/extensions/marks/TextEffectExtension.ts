// eigenpal #424 (gap 11) — w:effect text animation hint.
//
// Word 2013+ deprecates the animations themselves, but the formatting still
// round-trips. The painter emits `docx-text-effect-<name>` classes plus a
// `data-effect` attribute; host CSS opts in to actual animations rather than
// us forcing them. parseDOM rejects spans without a recognised data-effect,
// so a pasted unrelated span cannot mint a bogus mark.

import type { TextEffect } from "../../../types/document";
import { TEXT_EFFECT_VALUES } from "../../../types/documentEnumValues";
import { expectTextEffectMarkAttrs } from "../../attrs";
import { createMarkExtension } from "../create";

type Variant = Exclude<TextEffect, "none">;

const VARIANTS = TEXT_EFFECT_VALUES.filter(
  (value): value is Variant => value !== "none",
);

const isVariant = (value: string | null): value is Variant =>
  value !== null && (VARIANTS as readonly string[]).includes(value);

export const TextEffectExtension = createMarkExtension({
  name: "textEffect",
  schemaMarkName: "textEffect",
  markSpec: {
    attrs: {
      effect: {},
    },
    parseDOM: [
      {
        tag: "span[data-effect]",
        getAttrs: (dom) => {
          const value = dom.dataset["effect"] ?? null;
          if (!isVariant(value)) {
            return false;
          }
          return { effect: value };
        },
      },
    ],
    toDOM(mark) {
      const { effect } = expectTextEffectMarkAttrs(mark);
      return [
        "span",
        {
          class: `docx-text-effect docx-text-effect-${effect}`,
          "data-effect": effect,
        },
        0,
      ];
    },
  },
});
