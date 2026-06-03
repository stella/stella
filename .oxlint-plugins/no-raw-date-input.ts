// Disallow native HTML date inputs in product UI.
//
// `<input type="date">` (and friends: datetime-local, time, month, week)
// ship the browser's native picker, which:
//   - has inconsistent UX across browsers and platforms,
//   - cannot match Stella's typography, focus styles, or keyboard rhythm,
//   - cannot honour the user's preferred date format / locale,
//   - cannot share min/max/disabled logic with the rest of the design system.
//
// Use `<DatePickerPopover>` from `@/components/date-picker-popover`
// (which wraps `@stll/ui/components/date-picker-popover`) instead.
//
// Flagged:
//   <input type="date" ... />
//   <Input type="date" ... />
//   <input type={"datetime-local"} ... />
//
// Allowed:
//   <DatePickerPopover value={x} onChange={setX} />
//   <input type="text" ... />     (other input types are fine)

const BANNED_TYPES = new Set([
  "date",
  "datetime-local",
  "time",
  "month",
  "week",
]);

// Component names that wrap a native input and forward `type`. Add to
// this list if new wrappers ship; they should expose a calendar prop
// surface instead of accepting raw `type="date"`.
const INPUT_LIKE_COMPONENTS = new Set([
  "input", // native
  "Input", // @stll/ui Input
]);

type RuleContext = {
  report: (descriptor: {
    node: unknown;
    messageId: string;
    data?: Record<string, string>;
  }) => void;
};

type JSXIdentifier = { type: "JSXIdentifier"; name: string };
type JSXLiteral = { type: "Literal"; value: unknown };
type JSXExpressionContainer = {
  type: "JSXExpressionContainer";
  expression: { type: string; value?: unknown };
};
type JSXAttribute = {
  type: "JSXAttribute";
  name: JSXIdentifier | { type: string; name?: string };
  value: JSXLiteral | JSXExpressionContainer | null;
  parent?: { type: string; name?: { type: string; name?: string } };
};

const getStringValue = (value: JSXAttribute["value"]): string | undefined => {
  if (!value) {
    return undefined;
  }
  if (value.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  if (
    value.type === "JSXExpressionContainer" &&
    value.expression.type === "Literal" &&
    typeof value.expression.value === "string"
  ) {
    return value.expression.value;
  }
  return undefined;
};

export default {
  meta: { name: "no-raw-date-input" },
  rules: {
    "no-raw-date-input": {
      meta: {
        type: "problem",
        messages: {
          rawDateInput:
            'Native <{{tag}} type="{{kind}}"> uses the browser\'s picker, ' +
            "which can't match the design system or the user's locale. " +
            "Use <DatePickerPopover /> from " +
            "@/components/date-picker-popover instead.",
        },
      },
      create(context: RuleContext) {
        return {
          JSXAttribute(node: JSXAttribute) {
            if (
              node.name.type !== "JSXIdentifier" ||
              node.name.name !== "type"
            ) {
              return;
            }
            const kind = getStringValue(node.value);
            if (!kind || !BANNED_TYPES.has(kind)) {
              return;
            }
            const opening = node.parent;
            if (!opening || opening.type !== "JSXOpeningElement") {
              return;
            }
            const tag = opening.name;
            if (!tag || tag.type !== "JSXIdentifier" || !tag.name) {
              return;
            }
            if (!INPUT_LIKE_COMPONENTS.has(tag.name)) {
              return;
            }
            context.report({
              node,
              messageId: "rawDateInput",
              data: { tag: tag.name, kind },
            });
          },
        };
      },
    },
  },
};
