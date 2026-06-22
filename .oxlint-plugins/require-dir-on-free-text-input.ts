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
// Also flagged: a FREE-TEXT input in a numeric `inputMode`
// ("numeric"|"decimal") whose `dir` is absent or not `"ltr"`. A value like
// "0:30" or "350.00" has no strong directional character, so it falls back to
// the surrounding RTL direction and the field aligns/edits backwards — these
// must use `dir="ltr"`. The message points straight at `dir="ltr"` (not the
// generic "add dir=auto" hint) so such an input is never told to add a value
// the rule would immediately re-flag. A real `type="number"` (or any
// structured type) is already LTR by the browser and stays exempt.

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
          numericDir:
            'Numeric input (inputMode "numeric"/"decimal") must use dir="ltr": ' +
            "a value with no strong directional character inherits the " +
            "surrounding RTL direction and edits backwards.",
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
            const typeValue = literalValue(getAttr(node, "type"));
            const typeAttr = getAttr(node, "type");
            const isStructuredType =
              typeof typeValue === "string" && STRUCTURED_TYPES.has(typeValue);
            // A `type="number"` (or any structured type) input is already LTR
            // by the browser and never accepts RTL text, so it needs no `dir`.
            if (isStructuredType) {
              return;
            }
            // A free-text input in a numeric `inputMode` ("0:30", "350.00")
            // must stay LTR: its value has no strong directional character, so
            // `dir="auto"` (or no dir) resolves to the surrounding RTL
            // direction and the field aligns/edits backwards. Enforce
            // `dir="ltr"` directly — and point the message straight at it, not
            // the generic "add dir=auto" hint, which the rule would only
            // re-flag on the next pass.
            if (
              NUMERIC_INPUT_MODES.has(
                literalValue(getAttr(node, "inputMode")),
              ) &&
              literalValue(dirAttr) !== "ltr"
            ) {
              context.report({
                node: dirAttr ?? node,
                messageId: "numericDir",
              });
              return;
            }
            if (dirAttr !== undefined) {
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
