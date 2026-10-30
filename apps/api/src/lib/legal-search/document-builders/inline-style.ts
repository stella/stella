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

// Every reader below accepts only values its property's grammar allows: CSS
// ignores an invalid declaration, so it never overrides an earlier valid one.
// CSS-wide keywords resolve as CSS defines them: `initial` is the initial
// value, `inherit` (and `unset` for an inherited property) the parent's
// computed value, `unset` for a non-inherited one the initial value, and
// `revert` the element's default style.

const NORMAL_WEIGHT = 400;
const BOLD_WEIGHT = 700;
const BOLD_THRESHOLD = 600;
// User agents style these with `font-weight: bolder`.
const BOLDER_TAGS: ReadonlySet<string> = new Set(["b", "strong"]);
const NUMERIC_WEIGHT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/u;

/** `bolder` relative to the parent's computed weight (CSS Fonts 4). */
const bolderThan = (weight: number): number => {
  if (weight < 350) {
    return NORMAL_WEIGHT;
  }
  return weight < 550 ? BOLD_WEIGHT : 900;
};

/** `lighter` relative to the parent's computed weight (CSS Fonts 4). */
const lighterThan = (weight: number): number => {
  if (weight < 550) {
    return 100;
  }
  return weight < 750 ? NORMAL_WEIGHT : BOLD_WEIGHT;
};

const parentWeight = (element: Element): number =>
  element.parent !== null && isTag(element.parent)
    ? computedWeight(element.parent)
    : NORMAL_WEIGHT;

const defaultWeight = (element: Element): number =>
  BOLDER_TAGS.has(element.name)
    ? bolderThan(parentWeight(element))
    : parentWeight(element);

const ownWeight = (element: Element): number | undefined =>
  inlineStyleValue(element, (property, value) => {
    if (property !== "font-weight") {
      return undefined;
    }
    switch (value) {
      case "normal":
      case "initial":
        return { value: NORMAL_WEIGHT };
      case "bold":
        return { value: BOLD_WEIGHT };
      case "bolder":
        return { value: bolderThan(parentWeight(element)) };
      case "lighter":
        return { value: lighterThan(parentWeight(element)) };
      case "inherit":
      case "unset":
        return { value: parentWeight(element) };
      case "revert":
      case "revert-layer":
        return { value: defaultWeight(element) };
      default: {
        if (!NUMERIC_WEIGHT.test(value)) {
          return undefined;
        }
        const weight = Number(value);
        return weight >= 1 && weight <= 1000 ? { value: weight } : undefined;
      }
    }
  })?.value;

const computedWeight = (element: Element): number =>
  ownWeight(element) ?? defaultWeight(element);

/** Whether the element's own weight declaration computes to a bold weight. */
export const inlineStyleIsBold = (element: Element): boolean =>
  (ownWeight(element) ?? 0) >= BOLD_THRESHOLD;

// User agents style these with `font-style: italic`.
const ITALIC_TAGS: ReadonlySet<string> = new Set(["i", "em"]);
const OBLIQUE_ANGLE =
  /^oblique\s+[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:deg|grad|rad|turn)$/u;

const parentItalic = (element: Element): boolean =>
  element.parent !== null && isTag(element.parent)
    ? computedItalic(element.parent)
    : false;

const ownItalic = (element: Element): boolean | undefined =>
  inlineStyleValue(element, (property, value) => {
    if (property !== "font-style") {
      return undefined;
    }
    switch (value) {
      case "italic":
      case "oblique":
        return { value: true };
      case "normal":
      case "initial":
        return { value: false };
      case "inherit":
      case "unset":
        return { value: parentItalic(element) };
      case "revert":
      case "revert-layer":
        return {
          value: ITALIC_TAGS.has(element.name) || parentItalic(element),
        };
      default:
        return OBLIQUE_ANGLE.test(value) ? { value: true } : undefined;
    }
  })?.value;

const computedItalic = (element: Element): boolean =>
  ownItalic(element) ??
  (ITALIC_TAGS.has(element.name) || parentItalic(element));

/** Whether the element's own font style declaration computes to italic. */
export const inlineStyleIsItalic = (element: Element): boolean =>
  ownItalic(element) ?? false;

/**
 * Aspose's explicit horizontal-space markers. `-aw-import` is Aspose's own
 * property with no CSS grammar, so any nonempty value is a declaration of it.
 */
export const inlineStyleIsAsposeSpacer = (element: Element): boolean =>
  inlineStyleValue(element, (property, value) =>
    property === "-aw-import" && value.length > 0
      ? { value: value === "ignore" || value === "spaces" }
      : undefined,
  )?.value ?? false;

const DISPLAY_KEYWORDS: ReadonlySet<string> = new Set([
  "none",
  "contents",
  "block",
  "inline",
  "run-in",
  "flow",
  "flow-root",
  "inline-block",
  "list-item",
  "flex",
  "inline-flex",
  "grid",
  "inline-grid",
  "table",
  "inline-table",
  "table-row-group",
  "table-header-group",
  "table-footer-group",
  "table-row",
  "table-cell",
  "table-column-group",
  "table-column",
  "table-caption",
  "ruby",
  "ruby-base",
  "ruby-text",
  "ruby-base-container",
  "ruby-text-container",
  "math",
]);
const DISPLAY_OUTSIDE: ReadonlySet<string> = new Set([
  "block",
  "inline",
  "run-in",
]);
const DISPLAY_INSIDE: ReadonlySet<string> = new Set([
  "flow",
  "flow-root",
  "table",
  "flex",
  "grid",
  "ruby",
]);

/**
 * Whether a valid `display` value is inline-block (`inline-block`, or its
 * two-keyword form `inline flow-root`), or undefined for an invalid value.
 */
const displayIsInlineBlock = (value: string): boolean | undefined => {
  const keywords = value.split(/\s+/u);
  if (keywords.length === 1) {
    return DISPLAY_KEYWORDS.has(value) ? value === "inline-block" : undefined;
  }
  const outside = keywords.filter((keyword) => DISPLAY_OUTSIDE.has(keyword));
  const inside = keywords.filter((keyword) => DISPLAY_INSIDE.has(keyword));
  const listItems = keywords.filter((keyword) => keyword === "list-item");
  const valid =
    keywords.length <= 3 &&
    outside.length <= 1 &&
    inside.length <= 1 &&
    listItems.length <= 1 &&
    outside.length + inside.length + listItems.length === keywords.length &&
    (listItems.length === 0 ||
      inside.every((keyword) => keyword === "flow" || keyword === "flow-root"));
  if (!valid) {
    return undefined;
  }
  return (
    outside.at(0) === "inline" &&
    inside.at(0) === "flow-root" &&
    listItems.length === 0
  );
};

/** Whether the element's own display declaration computes to inline-block. */
export const inlineStyleIsInlineBlock = (element: Element): boolean =>
  inlineStyleValue(element, (property, value) => {
    if (property !== "display") {
      return undefined;
    }
    switch (value) {
      // `display` is not inherited, and no element this reads defaults to
      // inline-block.
      case "initial":
      case "unset":
      case "revert":
      case "revert-layer":
        return { value: false };
      case "inherit":
        return {
          value:
            element.parent !== null &&
            isTag(element.parent) &&
            inlineStyleIsInlineBlock(element.parent),
        };
      default: {
        const inlineBlock = displayIsInlineBlock(value);
        return inlineBlock === undefined ? undefined : { value: inlineBlock };
      }
    }
  })?.value ?? false;

const CSS_WIDE_KEYWORDS: ReadonlySet<string> = new Set([
  "initial",
  "inherit",
  "unset",
  "revert",
  "revert-layer",
]);
const LENGTH =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px|pt|pc|in|cm|mm|q|em|rem|ex|rex|ch|rch|cap|rcap|ic|ric|lh|rlh|vw|vh|vi|vb|vmin|vmax)$/u;

/**
 * The properties read for their presence, each with the values that declare
 * it. Aspose's own `-aw-*` properties have no CSS grammar.
 */
const DECLARED_PROPERTY_VALUES = {
  "letter-spacing": (value: string) =>
    value === "normal" ||
    CSS_WIDE_KEYWORDS.has(value) ||
    LENGTH.test(value) ||
    /^[+-]?0*\.?0+$/u.test(value),
  "-aw-headerfooter-type": (value: string) => value.length > 0,
} as const satisfies Record<string, (value: string) => boolean>;

type DeclaredProperty = keyof typeof DECLARED_PROPERTY_VALUES;

/** Whether a valid declaration names this property, whatever its value. */
export const inlineStyleDeclaresProperty = (
  element: Element,
  propertyName: DeclaredProperty,
): boolean =>
  inlineStyleValue(element, (property, value) =>
    property === propertyName && DECLARED_PROPERTY_VALUES[propertyName](value)
      ? { value: true }
      : undefined,
  )?.value ?? false;
