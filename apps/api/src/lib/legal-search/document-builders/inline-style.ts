// parser-output-unchanged: a new reader of an element's own style attribute; no parser calls it until it imports it, and the callers that do bump their versions.
import type { Element } from "domhandler";

/** What a property's declaration means, or undefined for a value CSS rejects. */
export type InlineStyleRead<T> = (
  property: string,
  value: string,
) => { readonly value: T } | undefined;

const IMPORTANT = /!\s*important\s*$/iu;

/**
 * The value an element's `style` attribute gives a property, as the cascade
 * picks it among the declarations `read` accepts: an `!important` one over any
 * other, and the later of two of the same weight. A declaration `read`
 * rejects is invalid and ignored, as a browser ignores it. Property names and
 * values reach `read` lowercased, without the `!important`.
 */
export const inlineStyleValue = <T>(
  element: Element,
  read: InlineStyleRead<T>,
): { readonly value: T } | undefined => {
  let winner: { readonly value: T; important: boolean } | undefined;
  for (const declaration of (element.attribs["style"] ?? "").split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const raw = declaration.slice(colon + 1).trim();
    const important = IMPORTANT.test(raw);
    const accepted = read(
      declaration.slice(0, colon).trim().toLowerCase(),
      raw.replace(IMPORTANT, "").trim().toLowerCase(),
    );
    if (accepted === undefined) {
      continue;
    }
    if (winner === undefined || important || !winner.important) {
      winner = { value: accepted.value, important };
    }
  }
  return winner === undefined ? undefined : { value: winner.value };
};
