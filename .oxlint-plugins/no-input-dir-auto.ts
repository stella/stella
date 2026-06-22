// Forbid `dir="auto"` on free-text form controls. The shared `<Input>` and
// `<Textarea>` (packages/ui) resolve direction themselves via `useContentDir`:
// an empty field omits `dir` so it inherits the ambient UI direction (caret on
// the RTL side under an Arabic UI), then switches to `dir="auto"` once there is
// text (Arabic content → RTL, Latin content → LTR).
//
// A literal `dir="auto"` on the field reintroduces the bug it was meant to fix:
// the bidi heuristic reads the *value*, and an empty value has no strong
// directional character, so it falls back to LTR and strands the caret on the
// left even under an RTL UI. Let the components manage direction; reach for
// `dir="ltr"` only on fixed-direction fields (numbers, codes, IDs).
//
// Flagged:
//   - any <input>/<textarea>/<Input>/<Textarea> with a literal `dir="auto"`.
//   - a free-text input in a numeric `inputMode` ("numeric"/"decimal") whose
//     `dir` is not `"ltr"`: a value like "0:30" or "350.00" has no strong
//     directional character, so without `dir="ltr"` it inherits the surrounding
//     RTL direction and aligns/edits backwards.
// Allowed: no `dir` (the component decides), `dir="ltr"`/`dir="rtl"` (forced),
// a computed `dir={…}` expression (the shared components emit this), or a
// structured `type` that is already LTR (tel/email/url/number/password/date…).

const INPUT_LIKE = new Set(["input", "textarea", "Input", "Textarea"]);

const NUMERIC_INPUT_MODES = new Set(["numeric", "decimal"]);

// `type` values that are NOT free text — these stay LTR, no `dir` needed.
const STRUCTURED_TYPES = new Set([
  "tel",
  "email",
  "url",
  "number",
  "password",
  "date",
  "datetime-local",
  "time",
  "month",
  "week",
  "range",
  "color",
  "checkbox",
  "radio",
  "file",
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
]);

const getAttr = (node, name) =>
  node.attributes.find(
    (attr) =>
      attr.type === "JSXAttribute" &&
      attr.name?.type === "JSXIdentifier" &&
      attr.name.name === name,
  );

export default {
  meta: { name: "no-input-dir-auto" },
  rules: {
    "no-input-dir-auto": {
      meta: {
        type: "problem",
        messages: {
          noAutoDir:
            'Remove `dir="auto"` from this field. The shared <Input>/<Textarea> ' +
            "resolve direction automatically (an empty field inherits the UI " +
            "direction; it switches to the content's direction once typed). Use " +
            '`dir="ltr"` only for fixed-direction fields (numbers, codes, IDs).',
          numericDir:
            'Numeric input (inputMode "numeric"/"decimal") must use dir="ltr": ' +
            "a value with no strong directional character inherits the " +
            "surrounding RTL direction and edits backwards.",
        },
      },
      create(context) {
        // Resolve a string/boolean literal whether written as a bare attribute
        // (dir="auto") or wrapped in an expression container (dir={"auto"}), so
        // the latter cannot bypass the rule.
        const literalValue = (attr) => {
          if (!attr?.value) {
            return undefined;
          }
          if (attr.value.type === "Literal") {
            return attr.value.value;
          }
          if (
            attr.value.type === "JSXExpressionContainer" &&
            attr.value.expression?.type === "Literal"
          ) {
            return attr.value.expression.value;
          }
          return undefined;
        };
        return {
          JSXOpeningElement(node) {
            if (
              node.name.type !== "JSXIdentifier" ||
              !INPUT_LIKE.has(node.name.name)
            ) {
              return;
            }
            const dirAttr = getAttr(node, "dir");
            const dirValue = literalValue(dirAttr);
            // The shared components own bidi direction; a literal auto is both
            // redundant and reintroduces the empty-field LTR fallback.
            if (dirValue === "auto") {
              context.report({ node: dirAttr ?? node, messageId: "noAutoDir" });
              return;
            }
            const typeValue = literalValue(getAttr(node, "type"));
            // Structured types are already LTR by the browser; nothing to do.
            if (
              typeof typeValue === "string" &&
              STRUCTURED_TYPES.has(typeValue)
            ) {
              return;
            }
            // Free-text field in a numeric inputMode must be explicitly LTR.
            if (
              NUMERIC_INPUT_MODES.has(
                literalValue(getAttr(node, "inputMode")),
              ) &&
              dirValue !== "ltr"
            ) {
              context.report({
                node: dirAttr ?? node,
                messageId: "numericDir",
              });
            }
          },
        };
      },
    },
  },
};
