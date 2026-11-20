// What counts as a disabled control with nothing to say about why.
//
// A disabled control that is silent about why is a dead end: the reader
// reaches for it, nothing happens, and nothing says what to do. `Button`
// takes a `disabledReason`, which becomes its tooltip while disabled and keeps
// it hoverable and focusable (`aria-disabled`).
//
// Flagged: a `Button` with a `disabled` attribute whose value is anything but
// the literal `false`, and no `disabledReason`.
// Allowed: `disabled={false}`, a `disabledReason` (any value, including one
// that is undefined while the button is enabled), and controls other than
// `Button`, which have no reason slot yet.

/** Controls whose disabled state must carry a `disabledReason`. */
export const REASONED_CONTROLS: ReadonlySet<string> = new Set(["Button"]);

export const DISABLED_REASON_ATTRIBUTE = "disabledReason";

// The JSX fields the predicate reads, each `unknown` until narrowed: declared
// rather than an index signature, so they read with plain dot access.
type JsxNodeLike = {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly value?: unknown;
  readonly expression?: unknown;
  readonly attributes?: unknown;
};

const isNode = (value: unknown): value is JsxNodeLike =>
  typeof value === "object" && value !== null && "type" in value;

const identifierName = (name: unknown): string | null =>
  isNode(name) && name.type === "JSXIdentifier" && typeof name.name === "string"
    ? name.name
    : null;

// `disabled={false}`: the literal says the control is never disabled here.
const isLiteralFalse = (value: unknown): boolean => {
  if (!isNode(value) || value.type !== "JSXExpressionContainer") {
    return false;
  }
  const expression = value.expression;
  return (
    isNode(expression) &&
    expression.type === "Literal" &&
    expression.value === false
  );
};

/**
 * The index, in the element's attributes, of the `disabled` attribute of a
 * reasoned control that carries no `disabledReason`, or null when the element
 * is fine. An index, so a caller reports its own typed attribute node.
 */
export const disabledAttributeWithoutReason = (
  openingElement: unknown,
): number | null => {
  if (
    !isNode(openingElement) ||
    openingElement.type !== "JSXOpeningElement" ||
    !Array.isArray(openingElement.attributes)
  ) {
    return null;
  }
  const name = identifierName(openingElement.name);
  if (name === null || !REASONED_CONTROLS.has(name)) {
    return null;
  }
  let disabled: number | null = null;
  for (const [index, attribute] of openingElement.attributes.entries()) {
    if (!isNode(attribute) || attribute.type !== "JSXAttribute") {
      continue;
    }
    const attributeName = identifierName(attribute.name);
    if (attributeName === DISABLED_REASON_ATTRIBUTE) {
      return null;
    }
    if (attributeName === "disabled" && !isLiteralFalse(attribute.value)) {
      disabled = index;
    }
  }
  return disabled;
};
