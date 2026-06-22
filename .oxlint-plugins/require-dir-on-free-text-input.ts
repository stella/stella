// Require a `dir` attribute on free-text inputs so mixed Arabic/Latin
// content aligns and the caret behaves correctly under an RTL UI.
//
// Without `dir`, a free-text field inherits the surrounding direction:
// an Arabic name typed into an LTR-defaulted field (or vice-versa)
// caret-jumps and its punctuation lands on the wrong side. `dir="auto"`
// applies the first-strong-character heuristic per value.
//
// Flagged: <input>, <textarea>, <Input>, <Textarea> with no `dir` and a
// free-text (or absent) `type`.
// Allowed: a `dir` attribute is present, OR `type` is a structured kind
// that must stay LTR (tel/email/url/number/password/date…), OR `type` is
// a dynamic expression we can't resolve (skipped to avoid false flags).
//
// Also flagged: a NUMERIC input (`inputMode="numeric"|"decimal"`) with
// `dir="auto"`. A value like "0:30" or "350.00" has no strong directional
// character, so `dir="auto"` falls back to the surrounding RTL direction and
// the field aligns/edits backwards — numeric inputs must use `dir="ltr"`.

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
  meta: { name: "require-dir-on-free-text-input" },
  rules: {
    "require-dir-on-free-text-input": {
      meta: {
        type: "problem",
        messages: {
          missingDir:
            "Free-text input needs a `dir` for bidirectional content. Add " +
            'dir="auto" (structured inputs like tel/email/url/number stay LTR).',
          numericDirAuto:
            'Numeric input (inputMode "numeric"/"decimal") must use dir="ltr", ' +
            'not dir="auto": a value with no strong directional character ' +
            "inherits the surrounding RTL direction and edits backwards.",
        },
      },
      create(context) {
        const literalValue = (attr) =>
          attr?.value?.type === "Literal" ? attr.value.value : undefined;
        return {
          JSXOpeningElement(node) {
            if (
              node.name.type !== "JSXIdentifier" ||
              !INPUT_LIKE.has(node.name.name)
            ) {
              return;
            }
            const dirAttr = getAttr(node, "dir");
            // Numeric inputs must stay LTR; dir="auto" resolves to RTL here.
            if (
              NUMERIC_INPUT_MODES.has(
                literalValue(getAttr(node, "inputMode")),
              ) &&
              literalValue(dirAttr) === "auto"
            ) {
              context.report({ node: dirAttr, messageId: "numericDirAuto" });
              return;
            }
            if (dirAttr !== undefined) {
              return;
            }
            const typeValue = literalValue(getAttr(node, "type"));
            const typeAttr = getAttr(node, "type");
            if (
              typeof typeValue === "string" &&
              STRUCTURED_TYPES.has(typeValue)
            ) {
              return;
            }
            if (typeAttr !== undefined && typeValue === undefined) {
              // Dynamic `type={…}` — can't tell if free-text; don't flag.
              return;
            }
            context.report({ node, messageId: "missingDir" });
          },
        };
      },
    },
  },
};
