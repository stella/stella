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

/** Whether the element's own weight requests bold emphasis. */
export const inlineStyleIsBold = (element: Element): boolean =>
  inlineStyleValue(element, (property, value) => {
    if (property !== "font-weight") {
      return undefined;
    }
    if (value === "bold" || value === "bolder") {
      return { value: true };
    }
    if (value === "normal" || value === "lighter") {
      return { value: false };
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/u.test(value)) {
      return undefined;
    }
    const weight = Number(value);
    return weight >= 1 && weight <= 1000 ? { value: weight >= 600 } : undefined;
  })?.value ?? false;

/** Whether the element's own font style requests italic emphasis. */
export const inlineStyleIsItalic = (element: Element): boolean =>
  inlineStyleValue(element, (property, value) => {
    if (property !== "font-style") {
      return undefined;
    }
    if (value === "italic" || value === "oblique") {
      return { value: true };
    }
    return value === "normal" ? { value: false } : undefined;
  })?.value ?? false;

/** Aspose's explicit horizontal-space markers. */
export const inlineStyleIsAsposeSpacer = (element: Element): boolean =>
  inlineStyleValue(element, (property, value) =>
    property === "-aw-import" && value.length > 0
      ? { value: value === "ignore" || value === "spaces" }
      : undefined,
  )?.value ?? false;

/** Whether the element's own display is the inline-block keyword. */
export const inlineStyleIsInlineBlock = (element: Element): boolean =>
  inlineStyleValue(element, (property, value) =>
    property === "display" && value.length > 0
      ? { value: value === "inline-block" }
      : undefined,
  )?.value ?? false;

/** Whether a nonempty declaration names this property, regardless of its value. */
export const inlineStyleDeclaresProperty = (
  element: Element,
  propertyName: string,
): boolean =>
  inlineStyleValue(element, (property, value) =>
    property === propertyName && value.length > 0 ? { value: true } : undefined,
  )?.value ?? false;
