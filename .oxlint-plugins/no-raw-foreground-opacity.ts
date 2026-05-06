// Detect text-like foreground opacity utilities that should use named
// attenuation tokens instead.
//
// Safe:
//   text-foreground-muted
//   placeholder:text-foreground-placeholder
//   decoration-foreground-disabled
//
// Flagged:
//   text-muted-foreground/60
//   hover:text-foreground/80
//   placeholder:text-muted-foreground/64

const TEXT_FOREGROUND_OPACITY_PATTERN =
  /(?:^|:)(?:placeholder:text|text|decoration)-(?:muted-foreground|foreground)\/\d+(?:\b|$)/;

type ReportContext = {
  report: (descriptor: {
    node: unknown;
    messageId: string;
    data?: Record<string, string>;
  }) => void;
};

type LiteralNode = {
  value: unknown;
};

type TemplateElementNode = {
  value: {
    raw: string;
  };
};

const findRawForegroundOpacity = (value: string): string | undefined => {
  for (const token of value.split(/\s+/)) {
    if (TEXT_FOREGROUND_OPACITY_PATTERN.test(token)) {
      return token;
    }
  }

  return undefined;
};

function checkValue(context: ReportContext, node: unknown, value: string) {
  const match = findRawForegroundOpacity(value);

  if (!match) {
    return;
  }

  context.report({
    node,
    messageId: "rawForegroundOpacity",
    data: { match },
  });
}

export default {
  meta: { name: "no-raw-foreground-opacity" },
  rules: {
    "no-raw-foreground-opacity": {
      meta: {
        type: "problem",
        messages: {
          rawForegroundOpacity:
            "Raw foreground opacity '{{match}}' hides visual intent. " +
            "Use a named token such as text-foreground-muted, " +
            "text-foreground-placeholder, text-foreground-label, or " +
            "text-foreground-strong-muted.",
        },
      },
      create(context: ReportContext) {
        return {
          Literal(node: LiteralNode) {
            if (typeof node.value !== "string") {
              return;
            }

            checkValue(context, node, node.value);
          },
          TemplateElement(node: TemplateElementNode) {
            checkValue(context, node, node.value.raw);
          },
        };
      },
    },
  },
};
