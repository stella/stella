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

const INPUT_LIKE = new Set(["input", "textarea", "Input", "Textarea"]);

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
        },
      },
      create(context) {
        return {
          JSXOpeningElement(node) {
            if (
              node.name.type !== "JSXIdentifier" ||
              !INPUT_LIKE.has(node.name.name)
            ) {
              return;
            }
            if (getAttr(node, "dir") !== undefined) {
              return;
            }
            const typeAttr = getAttr(node, "type");
            // Resolve a string-literal `type`; skip dynamic types.
            const typeValue =
              typeAttr?.value?.type === "Literal"
                ? typeAttr.value.value
                : undefined;
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
