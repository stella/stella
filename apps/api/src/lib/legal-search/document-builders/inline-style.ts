// parser-output-unchanged: adds named readers beside the unchanged `inlineStyleValue`; output changes only in parsers that call them, and those bump their own versions.
import { isTag } from "domhandler";
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

/** An inherited emphasis property: its keyword values and the tags that default to it. */
type InheritedEmphasis = {
  property: string;
  /** Whether a specified value emphasizes, or undefined for one CSS rejects. */
  emphasizes: (value: string) => boolean | undefined;
  defaultTags: ReadonlySet<string>;
};

const BOLD: InheritedEmphasis = {
  property: "font-weight",
  emphasizes: (value) => {
    if (value === "bold" || value === "bolder") {
      return true;
    }
    if (value === "normal" || value === "lighter") {
      return false;
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/u.test(value)) {
      return undefined;
    }
    const weight = Number(value);
    return weight >= 1 && weight <= 1000 ? weight >= 600 : undefined;
  },
  defaultTags: new Set(["b", "strong"]),
};

const ITALIC: InheritedEmphasis = {
  property: "font-style",
  emphasizes: (value) => {
    if (value === "italic" || value === "oblique") {
      return true;
    }
    return value === "normal" ? false : undefined;
  },
  defaultTags: new Set(["i", "em"]),
};

// CSS-wide keywords for an inherited property: `initial` is the property's
// initial value (not emphasized), `inherit` and `unset` take the parent's
// computed value, and `revert` falls back to the element's default style.
const ownEmphasis = (
  element: Element,
  emphasis: InheritedEmphasis,
): boolean | undefined =>
  inlineStyleValue(element, (property, value) => {
    if (property !== emphasis.property) {
      return undefined;
    }
    switch (value) {
      case "initial":
        return { value: false };
      case "inherit":
      case "unset":
        return { value: inheritedEmphasis(element, emphasis) };
      case "revert":
      case "revert-layer":
        return { value: emphasis.defaultTags.has(element.name) };
      default: {
        const emphasizes = emphasis.emphasizes(value);
        return emphasizes === undefined ? undefined : { value: emphasizes };
      }
    }
  })?.value;

const computedEmphasis = (
  element: Element,
  emphasis: InheritedEmphasis,
): boolean =>
  ownEmphasis(element, emphasis) ??
  (emphasis.defaultTags.has(element.name) ||
    inheritedEmphasis(element, emphasis));

const inheritedEmphasis = (
  element: Element,
  emphasis: InheritedEmphasis,
): boolean =>
  element.parent !== null && isTag(element.parent)
    ? computedEmphasis(element.parent, emphasis)
    : false;

/** Whether the element's own weight declaration requests bold emphasis. */
export const inlineStyleIsBold = (element: Element): boolean =>
  ownEmphasis(element, BOLD) ?? false;

/** Whether the element's own font style declaration requests italic emphasis. */
export const inlineStyleIsItalic = (element: Element): boolean =>
  ownEmphasis(element, ITALIC) ?? false;

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
