// Disallow string literal comparisons against domain values
// (MIME types, HTTP methods, file extensions).
//
// Use named constants instead of comparing against magic strings.
// This catches typos at compile time and makes refactoring safer.

const MIME_TYPE = /^(?:application|text|image|audio|video|font)\//;
const HTTP_METHOD =
  /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;
const FILE_EXTENSION =
  /^\.?(?:pdf|docx?|xlsx?|pptx?|csv|txt|html?|xml|json|png|jpe?g|gif|svg|webp|mp[34]|wav|ogg|woff2?|ttf|eot)$/;

const isDomainLiteral = (value: string): boolean =>
  MIME_TYPE.test(value) ||
  HTTP_METHOD.test(value) ||
  FILE_EXTENSION.test(value);

function checkNode(context, node) {
  if (
    node.type !== "Literal" ||
    typeof node.value !== "string"
  ) {
    return;
  }

  if (isDomainLiteral(node.value)) {
    context.report({
      node,
      messageId: "domainLiteral",
      data: { value: node.value },
    });
  }
}

export default {
  meta: { name: "no-domain-string-literals" },
  rules: {
    "no-domain-string-literals": {
      meta: {
        type: "suggestion",
        messages: {
          domainLiteral:
            "Don't compare against domain string literal " +
            "'{{value}}'. Extract to a named constant.",
        },
      },
      create(context) {
        return {
          BinaryExpression(node) {
            if (
              node.operator !== "===" &&
              node.operator !== "!==" &&
              node.operator !== "==" &&
              node.operator !== "!="
            ) {
              return;
            }

            checkNode(context, node.left);
            checkNode(context, node.right);
          },
          SwitchCase(node) {
            if (node.test?.type === "Literal") {
              checkNode(context, node.test);
            }
          },
        };
      },
    },
  },
};
