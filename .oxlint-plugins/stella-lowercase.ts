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
//   `${label} Stella refused`               // non-head template quasi
//
// Allows:
//   "Stella API request failed"             // start of string = sentence start
//   "Workflow paused. Stella resumed"       // after `. ` = sentence start
//   "„Stella" je dobrá volba"               // after typographic opener
//   "¿Stella está cargando?"                // after Spanish opener
//   "StellaMark" / "stellaToast"            // PascalCase / camelCase identifier text
//   "Stella-macos-universal.dmg"            // asset filename (hyphen suffix)
//   "Stella.app" / "Stella.dmg"             // bundle identifier (dot + lowercase)
//   "./components/StellaMark"               // path string (import / asset path)
//   import x from "@stll/stella-thing"      // import / export source strings
//
// Sentence-start positions:
//   - Start of the first quasi of a template literal, or start of a
//     non-template string literal / JSX text.
//   - Immediately after `.`, `!`, `?`, `…`, or a newline, optionally
//     followed by whitespace and opening quote / bracket characters
//     (ASCII `"`, `'`, `` ` ``, `(`, `[`, `{`; typographic
//     `“`, `”`, `‘`, `’`, `„`, `«`, `»`, `‹`, `›`; Spanish `¿`, `¡`).
//
// Non-head template quasis (text after `${…}`) and JSX text nodes
// that follow a sibling expression / element do not get the
// start-of-text sentence-start carve-out, because the preceding
// expression or element could substitute any value.
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

// Whitespace characters to skip when scanning back for the previous
// significant character (ASCII space, tab, NBSP).
const SKIP_WHITESPACE = new Set([" ", "\t", " "]);

// Quote and bracket characters that open a quoted span. Sentence-start
// position is then determined by what precedes the opener. Covers ASCII
// quotes plus the typographic / localized quote families our copy uses
// (curly EN, German low-9 `„`, French/Spanish guillemets, single
// guillemets) and Spanish opening exclamation / question marks.
const SKIP_OPENERS = new Set([
  '"',
  "'",
  "`",
  "(",
  "[",
  "{",
  "“",
  "”",
  "‘",
  "’",
  "„",
  "«",
  "»",
  "‹",
  "›",
  "¿",
  "¡",
]);

const SENTENCE_TERMINATORS = new Set([".", "!", "?", "…", "\n", "\r"]);

// Walk back past whitespace and quote-like openers to find the previous
// significant character. Sentence-start when that character is a
// terminator (`. ! ? …`) or a newline. When no preceding character exists,
// only treat as sentence-start if `isContinuation` is false; non-head
// template quasis can be preceded by arbitrary expression output, so a
// bare quasi-start is not a sentence boundary.
const isSentenceStart = (
  text: string,
  idx: number,
  isContinuation: boolean,
): boolean => {
  let i = idx - 1;
  while (i >= 0) {
    const ch = text[i];
    if (SKIP_WHITESPACE.has(ch) || SKIP_OPENERS.has(ch)) {
      i--;
      continue;
    }
    // In a continuation, newlines at the start of the text come from
    // source formatting around the preceding expression/element, not
    // from a real prose line break, so walk past them too.
    if (isContinuation && (ch === "\n" || ch === "\r")) {
      i--;
      continue;
    }
    break;
  }
  if (i < 0) {
    return !isContinuation;
  }
  return SENTENCE_TERMINATORS.has(text[i]);
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
  isContinuation: boolean,
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
    if (
      !isSentenceStart(value, start, isContinuation) &&
      !isCodeLikeSuffix(value, end)
    ) {
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

// A JSXText node that is not the first child of its parent JSX
// element / fragment can be preceded by a sibling expression
// (`<p>{name} Stella…</p>`) or a sibling element with arbitrary
// trailing content. Treat its start position as a continuation
// of preceding output rather than as a sentence start.
const isJsxContinuation = (node: AstNode): boolean => {
  const parent = node.parent;
  if (!isAstNode(parent)) {
    return false;
  }
  if (parent.type !== "JSXElement" && parent.type !== "JSXFragment") {
    return false;
  }
  const children = parent.children;
  if (!Array.isArray(children)) {
    return false;
  }
  return children.indexOf(node) > 0;
};

const quasiText = (quasi: unknown): string | null => {
  if (!isAstNode(quasi)) {
    return null;
  }
  const raw = quasi.value;
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const cooked = (raw as { cooked?: unknown }).cooked;
  if (typeof cooked === "string") {
    return cooked;
  }
  const rawValue = (raw as { raw?: unknown }).raw;
  return typeof rawValue === "string" ? rawValue : null;
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
            checkText(context, node, node.value, false);
          },
          TemplateLiteral(node: AstNode) {
            if (!Array.isArray(node.quasis)) {
              return;
            }
            for (let i = 0; i < node.quasis.length; i++) {
              const quasi = node.quasis[i];
              const value = quasiText(quasi);
              if (value === null) {
                continue;
              }
              checkText(context, quasi, value, i > 0);
            }
          },
          JSXText(node: AstNode) {
            if (typeof node.value !== "string") {
              return;
            }
            checkText(context, node, node.value, isJsxContinuation(node));
          },
        };
      },
    },
  },
};
