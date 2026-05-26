// Disallow untranslated user-facing JSX text in product UI.
// oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/strict-boolean-expressions
//
// Stella uses use-intl for runtime translations. Raw JSX text children
// regress i18n coverage because they do not appear in locale JSON files
// and are easy for generated UI code to introduce.
//
// Flags:
//   <Button>Save</Button>
//   <p>{"Matter created"}</p>
//   <>Unable to load workspace</>
//
// Allows:
//   <Button>{t("common.save")}</Button>
//   <code>workspaceId</code>
//   <span>•</span>
//   <span>PDF</span>

type AstNode = { type: string } & Record<string, unknown>;

type RuleContext = {
  getSourceCode?: () => { text?: unknown };
  options?: unknown[];
  report: (diagnostic: {
    node: unknown;
    messageId: "untranslatedText";
    data: { text: string };
  }) => void;
  sourceCode?: { text?: unknown };
};

const DEFAULT_IGNORED_ELEMENT_NAMES = [
  "code",
  "kbd",
  "pre",
  "samp",
  "script",
  "style",
  "var",
];

const DEFAULT_ALLOWED_TEXT = [
  "AI",
  "API",
  "AWS",
  "CSV",
  "DOCX",
  "HTML",
  "HTTP",
  "HTTPS",
  "ID",
  "IDs",
  "JSON",
  "MCP",
  "OAuth",
  "PDF",
  "S3",
  "SOC 2",
  "SQL",
  "URL",
  "URLs",
  "UTC",
  "XML",
  "ISO 27001",
];

const HAS_LETTER = /\p{L}/u;
const HTML_ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]+|#\d+|#x[\dA-Fa-f]+);/gu;
const CONSTANT_LIKE_TEXT = /^(?=.*[0-9_./+-])[A-Z0-9_./+-]{2,}$/u;
const PACKAGE_IDENTIFIER = /^@[\w.-]+\/[\w.-]+$/u;
const PAGE_ABBREVIATION = /^p{1,2}\.$/iu;

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeText = (value: string): string =>
  value
    .replace(HTML_ENTITY, " ")
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

const reportText = (value: string): string =>
  value.length > 40 ? `${value.slice(0, 37)}...` : value;

const getStringLiteralValue = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type !== "TemplateLiteral") {
    return null;
  }
  if (!Array.isArray(node.expressions) || node.expressions.length > 0) {
    return null;
  }
  if (!Array.isArray(node.quasis) || node.quasis.length !== 1) {
    return null;
  }
  const quasi = node.quasis.at(0);
  if (!isAstNode(quasi)) {
    return null;
  }
  const value = quasi.value;
  if (!isRecord(value)) {
    return null;
  }
  const cooked = value.cooked;
  const raw = value.raw;
  if (typeof cooked === "string") {
    return cooked;
  }
  return typeof raw === "string" ? raw : null;
};

const getJsxName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    const propertyName = getJsxName(node.property);
    return propertyName;
  }
  if (node.type === "JSXNamespacedName") {
    return getJsxName(node.name);
  }
  return null;
};

const getElementName = (element: unknown): string | null => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  const openingElement = element.openingElement;
  if (!isAstNode(openingElement)) {
    return null;
  }
  return getJsxName(openingElement.name);
};

const hasIgnoredAncestor = (
  node: unknown,
  ignoredElementNames: ReadonlySet<string>,
): boolean => {
  let current = isAstNode(node) ? node.parent : null;
  while (isAstNode(current)) {
    if (current.type === "JSXElement") {
      const name = getElementName(current);
      if (name !== null && ignoredElementNames.has(name)) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
};

const isJsxChildExpression = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const parent = node.parent;
  return (
    isAstNode(parent) &&
    (parent.type === "JSXElement" || parent.type === "JSXFragment")
  );
};

const stringArrayOption = (options: Record<string, unknown>, key: string) => {
  const value = options[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const regexArrayOption = (
  options: Record<string, unknown>,
  key: string,
): RegExp[] =>
  stringArrayOption(options, key).flatMap((pattern) => {
    try {
      return [new RegExp(pattern, "u")];
    } catch {
      return [];
    }
  });

const sourceTextForContext = (context: RuleContext): string => {
  if (typeof context.sourceCode?.text === "string") {
    return context.sourceCode.text;
  }
  const fallback = context.getSourceCode?.();
  return typeof fallback?.text === "string" ? fallback.text : "";
};

export default {
  meta: { name: "no-untranslated-jsx-literal" },
  rules: {
    "no-untranslated-jsx-literal": {
      meta: {
        type: "problem",
        messages: {
          untranslatedText:
            "Translate JSX text '{{text}}' with useTranslations()/t(...), or add an explicit disable for non-user-facing copy.",
        },
        schema: [
          {
            type: "object",
            properties: {
              allowedText: {
                type: "array",
                items: { type: "string" },
              },
              allowedTextPatterns: {
                type: "array",
                items: { type: "string" },
              },
              ignoredElementNames: {
                type: "array",
                items: { type: "string" },
              },
              requireTranslationUsage: { type: "boolean" },
              translationMarkers: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      create(context: RuleContext) {
        const options = isRecord(context.options?.[0])
          ? context.options[0]
          : {};
        const translationMarkers =
          stringArrayOption(options, "translationMarkers").length > 0
            ? stringArrayOption(options, "translationMarkers")
            : ["useTranslations", "getTranslations", "TranslationKey"];

        if (options.requireTranslationUsage === true) {
          const sourceText = sourceTextForContext(context);
          if (
            !translationMarkers.some((marker) => sourceText.includes(marker))
          ) {
            return {};
          }
        }

        const ignoredElementNames = new Set([
          ...DEFAULT_IGNORED_ELEMENT_NAMES,
          ...stringArrayOption(options, "ignoredElementNames"),
        ]);
        const allowedText = new Set([
          ...DEFAULT_ALLOWED_TEXT,
          ...stringArrayOption(options, "allowedText"),
        ]);
        const allowedTextPatterns = regexArrayOption(
          options,
          "allowedTextPatterns",
        );

        const shouldIgnoreText = (rawValue: string): boolean => {
          const text = normalizeText(rawValue);
          if (text.length <= 1) {
            return true;
          }
          if (!HAS_LETTER.test(text)) {
            return true;
          }
          if (allowedText.has(text)) {
            return true;
          }
          if (PAGE_ABBREVIATION.test(text) || PACKAGE_IDENTIFIER.test(text)) {
            return true;
          }
          if (CONSTANT_LIKE_TEXT.test(text) && text.length <= 12) {
            return true;
          }
          return allowedTextPatterns.some((pattern) => pattern.test(text));
        };

        const checkText = (node: unknown, rawValue: string) => {
          const text = normalizeText(rawValue);
          if (shouldIgnoreText(text)) {
            return;
          }
          if (hasIgnoredAncestor(node, ignoredElementNames)) {
            return;
          }
          context.report({
            node,
            messageId: "untranslatedText",
            data: { text: reportText(text) },
          });
        };

        return {
          JSXText(node: AstNode) {
            if (typeof node.value !== "string") {
              return;
            }
            checkText(node, node.value);
          },
          JSXExpressionContainer(node: AstNode) {
            if (!isJsxChildExpression(node)) {
              return;
            }
            const value = getStringLiteralValue(node.expression);
            if (value === null) {
              return;
            }
            checkText(node, value);
          },
        };
      },
    },
  },
};
