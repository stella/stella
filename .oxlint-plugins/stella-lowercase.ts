// Enforce the lowercase "stella" wordmark in source text.
//
// Stella's brand identity is a lowercase wordmark. AI-generated copy and
// hand-written prose routinely introduce capitalised "Stella" mid-sentence,
// which contradicts the wordmark. This rule scans string literals, template
// literals, and JSX text for "Stella" tokens that aren't at a sentence
// boundary and that don't look like code identifiers or asset filenames.
//
// Flags:
//   throw new Error("Stella API request failed");
//   <p>Welcome to Stella</p>
//   `New sign-in to your Stella account`
//   "Powered by Stella."
//
// Allows:
//   "Stella API request failed"           // start of string = sentence start
//   "Workflow paused. Stella resumed"     // after `. ` = sentence start
//   "StellaMark" / "stellaToast"          // PascalCase / camelCase identifier text
//   "Stella-macos-universal.dmg"          // asset filename (hyphen suffix)
//   "Stella.app" / "Stella.dmg"           // bundle identifier (dot + lowercase)
//   "./components/StellaMark"             // path string (import / asset path)
//   import x from "@stll/stella-thing"    // import / export source strings
//
// Sentence-start positions:
//   - Start of the literal value (including template-quasi start)
//   - Immediately after `.`, `!`, `?`, `…`, or a newline, optionally
//     followed by whitespace and quoting characters.
//
// Disable narrowly with `// oxlint-disable-next-line
// stella-lowercase/stella-lowercase` and a comment explaining why the
// capitalisation is intentional (e.g. proper-noun list, third-party
// metadata field that requires the legacy casing).

import { isStringLiteral } from "./utils.ts";

type AstNode = { type: string; parent?: unknown } & Record<string, unknown>;

type RuleContext = {
  report: (diagnostic: {
    node: unknown;
    messageId: "lowercaseStella";
    data?: { match: string };
  }) => void;
};

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof (node as { type: unknown }).type === "string";

// `\bStella\b` rejects identifier embeddings (`FakeStellaApi`, `StellaMark`)
// because letters/digits on either side suppress the word boundary.
const STELLA_PATTERN = /\bStella\b/gu;

// Path-shaped strings (no spaces, only path-safe characters). Treated as
// asset / module paths and skipped wholesale so `./components/StellaMark`
// and `/Applications/Stella.app/Contents/MacOS/stella` don't flag.
const WHOLE_PATH = /^[\w./\\:~@-]+$/u;

// Walk back past whitespace and quoting characters to find the previous
// significant character. Sentence-start when that character is a
// terminator (`. ! ? …`) or a newline, or when no previous character
// exists at all.
const isSentenceStart = (text: string, idx: number): boolean => {
  let i = idx - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === " ") {
      i--;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`" || ch === "(" || ch === "[") {
      i--;
      continue;
    }
    break;
  }
  if (i < 0) {
    return true;
  }
  const prev = text[i];
  return (
    prev === "." ||
    prev === "!" ||
    prev === "?" ||
    prev === "…" ||
    prev === "\n" ||
    prev === "\r"
  );
};

// Treat `Stella-…`, `Stella_…`, and `Stella.<lowercase>…` as code-like
// suffixes (kebab asset names, snake identifiers, file extensions, bundle
// IDs). The word boundary already excluded uppercase / digit suffixes.
const isCodeLikeSuffix = (text: string, endIdx: number): boolean => {
  const next = text[endIdx];
  if (next === "-" || next === "_") {
    return true;
  }
  if (next === ".") {
    return /[a-z]/u.test(text[endIdx + 1] ?? "");
  }
  return false;
};

const checkText = (
  context: RuleContext,
  node: unknown,
  value: string,
): void => {
  if (!value.includes("Stella")) {
    return;
  }
  if (WHOLE_PATH.test(value)) {
    return;
  }
  STELLA_PATTERN.lastIndex = 0;
  let match = STELLA_PATTERN.exec(value);
  while (match !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (!isSentenceStart(value, start) && !isCodeLikeSuffix(value, end)) {
      context.report({
        node,
        messageId: "lowercaseStella",
        data: { match: match[0] },
      });
      return;
    }
    match = STELLA_PATTERN.exec(value);
  }
};

const isImportOrExportSource = (literalNode: AstNode): boolean => {
  const parent = literalNode.parent;
  if (!isAstNode(parent)) {
    return false;
  }
  return (
    parent.type === "ImportDeclaration" ||
    parent.type === "ExportNamedDeclaration" ||
    parent.type === "ExportAllDeclaration"
  );
};

export default {
  meta: { name: "stella-lowercase" },
  rules: {
    "stella-lowercase": {
      meta: {
        type: "problem",
        messages: {
          lowercaseStella:
            "Use lowercase `stella` for the product wordmark. `Stella` is only valid at a sentence start (string start, or after `. ! ? …`). PascalCase identifiers like `StellaMark`, kebab asset names like `Stella-macos.dmg`, and bundle IDs like `Stella.app` are unaffected.",
        },
      },
      create(context: RuleContext) {
        return {
          Literal(node: AstNode) {
            if (!isStringLiteral(node)) {
              return;
            }
            if (isImportOrExportSource(node)) {
              return;
            }
            checkText(context, node, node.value);
          },
          TemplateElement(node: AstNode) {
            const raw = node.value;
            if (typeof raw !== "object" || raw === null) {
              return;
            }
            const cooked = (raw as { cooked?: unknown }).cooked;
            if (typeof cooked === "string") {
              checkText(context, node, cooked);
              return;
            }
            const rawValue = (raw as { raw?: unknown }).raw;
            if (typeof rawValue === "string") {
              checkText(context, node, rawValue);
            }
          },
          JSXText(node: AstNode) {
            if (typeof node.value !== "string") {
              return;
            }
            checkText(context, node, node.value);
          },
        };
      },
    },
  },
};
