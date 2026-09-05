// Convention ratchet guard.
//
// A ratchet is a set of whole-repo metrics that may only ever DECREASE: each
// metric's current count is compared to a committed baseline, a rise fails CI
// (a new violation of a convention), and a fall just prompts you to run
// `--write` to lock in the improvement so it can never regress. This
// generalizes the ad hoc per-guard baselines (React Compiler bailouts, MCP
// pending) into one declarative table of dumb, deterministic, line-based
// counters: no AST, no oxlint, fast enough to keep the local loop honest.
//
// To add a metric: append an entry to RATCHET_METRICS with a stable `id`, a
// human `description`, and one of two `scope`s.
//   scope: "file" — the `include` globs (repo-relative), an `exclude`
//     predicate, and a `count(content)` per-file counter (a lexical/regex
//     scan; keep it deterministic and cheap).
//   scope: "repo" — a `count(root)` that walks the tree itself and returns
//     `{ count, files }`, for a property no single file carries: the same
//     helper copied into two apps, one name defined in two workspaces, the
//     size of a flat bucket.
// Then run `bun scripts/ratchet.ts --write` to seed its baseline, and commit
// both files. The counter must count exactly what its description claims —
// the `--self-test` fixtures enforce that.
//
// Lint-suppression budgets are the one generated family: one decrease-only
// budget per rule in TRACKED_SUPPRESSION_RULES (scripts/lint-suppressions.ts)
// plus a residual budget for every other rule, partitioned so no rule's
// burn-down can fund another rule's new waiver. Security-tier rules carry a
// waiver ledger on top (scripts/suppression-waivers.ts); the policy is written
// up in .oxlint-plugins/README.md.
//
// Modes:
//   bun scripts/ratchet.ts            report current counts vs baseline
//   bun scripts/ratchet.ts --check    CI gate (exit 1 only when a count rose)
//   bun scripts/ratchet.ts --write    regenerate the baseline
//   bun scripts/ratchet.ts --self-test prove each counter counts what it claims
//
// CI-only wiring lives in .github/workflows/ci.yml and scripts/verify.sh
// alongside the other ratchet guards.

import { panic, Result } from "better-result";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyse } from "scslre";
import ts from "typescript";

import { MCP_WRITE_ONLY_RESOURCE_SCOPES } from "../packages/api-contract/src/mcp";
import {
  collectLintDirectives,
  isResidualDirective,
  suppressesRule,
  suppressionMetricId,
  TRACKED_SUPPRESSION_RULES,
  type TrackedRule,
} from "./lint-suppressions";
import {
  isResultConventionExcludedFile,
  RESULT_CONVENTION_SOURCE_GLOBS,
} from "./result-boundary-globs";
import {
  ALL_SOURCE_GLOBS,
  isExcludedSource,
  isExcludedTestInclusiveSource,
} from "./source-globs";

const SCRIPTS_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");
const BASELINE_PATH = path.resolve(SCRIPTS_DIR, "ratchet-baseline.json");
const BASELINE_REL = "scripts/ratchet-baseline.json";
const WRITE_HINT = "bun scripts/ratchet.ts --write";
const INTERNAL_MODULE_MOCK_LEDGER_REL =
  "scripts/internal-module-mock-ledger.json";

// Shared source globs + exclusions for the app-source metrics.
const APP_SOURCE_GLOBS = [
  "apps/api/src/**/*.{ts,tsx}",
  "apps/web/src/**/*.{ts,tsx}",
] as const;

const isExcludedFromResultConventionMetrics = (file: string): boolean =>
  isExcludedSource(file) ||
  file.includes("/specs/") ||
  isResultConventionExcludedFile(file);

// --- Counters ---------------------------------------------------------------
// All counters take raw file text and return a per-file occurrence count. They
// are line-oriented so cheap comment/import filtering can drop obvious noise.

// Lines that are pure comments (JSDoc `*`, `//`, `/* ... */` openers).
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/u;
const LINE_COMMENT_TAIL = /\/\/.*/u;
// `as unknown as T` is one assertion, not two: collapse it before counting.
const AS_UNKNOWN_AS = /\bas\s+unknown\s+as\b/gu;
// A type assertion: ` as ` not immediately followed by `const`.
const AS_CAST = /\bas\s+(?!const\b)/gu;
const AS_UNKNOWN_PLACEHOLDER = "as  ";
const MAPPED_TYPE_REMAP_PLACEHOLDER = "remap ";
// Mapped types use `as` to remap keys (`[K in keyof T as F<K>]`). This is
// type-level syntax, not a value assertion. The `in` before `as` distinguishes
// it from computed array/index expressions that may contain a real assertion.
const MAPPED_TYPE_KEY_REMAP =
  /(?<mappedPrefix>\[[^\][]*\bin\b[^\][]*)\bas\s+/gu;

// Module syntax carries alias `as` (`import { x as y }`, `import * as ns`,
// `export { x as y }`, `export * as ns`) that is NOT a type assertion. These
// statements can span multiple lines, so exclude the whole statement, not just
// the opening line.
const MODULE_STMT_OPEN =
  /^\s*(?:import\b|export\s+(?:type\s+)?\{|export\s+\*)/u;
const MODULE_STMT_TERMINATOR = /\bfrom\b|\};?\s*$|;\s*$/u;

// --- String/template literal stripping --------------------------------------
// A regex counter scanning raw line text cannot tell "as" the type-assertion
// keyword from "as" the English word sitting inside a string, and a stray `//`
// inside a string (e.g. a URL) must not be mistaken for a comment tail. Every
// counter below first blanks string/template literal contents so it only ever
// scans code, keeping with the file's "dumb, deterministic, line-based — no
// AST" design: this is still a single char-by-char pass per line, carrying
// only the minimal state needed to survive a template literal that spans
// multiple lines.
//
// Trade-off: `${...}` interpolation inside a template literal is NOT parsed
// specially — the whole template span up to the next unescaped backtick is
// blanked, interpolation included. A cast written inside an interpolation
// (`` `${x as T}` ``) is therefore missed, and a backtick nested inside an
// interpolation (`` `${`nested`}` ``) is not handled correctly. Both are rare
// in practice; a lexer that tracks interpolation nesting (itself possibly
// containing new strings/templates) would no longer be "cheap" or
// "line-based". Accepted, documented fidelity limit — same spirit as the
// other known limitations called out in the self-test fixtures below.
const BLANKED_LITERAL = " ";

const QUOTE_CHARACTER = /['"`]/u;

type LiteralScanState = { readonly inTemplate: boolean };

const NO_OPEN_TEMPLATE: LiteralScanState = { inTemplate: false };

// Index of the next unescaped `quote` at or after `from`, or -1.
const findUnescapedQuote = (
  line: string,
  from: number,
  quote: string,
): number => {
  for (let i = from; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\") {
      i += 1; // skip the escaped character, whatever it is
      continue;
    }
    if (ch === quote) {
      return i;
    }
  }
  return -1;
};

// Blank string/template literal contents in `raw`, carrying open-template
// state across lines. Returns the remaining code (literal contents replaced
// by a single space, so word boundaries around the literal still hold) plus
// the state to pass into the next line.
const stripStringLiterals = (
  raw: string,
  state: LiteralScanState,
): { code: string; state: LiteralScanState } => {
  // Most lines in the tree hold no literal at all, and the scan below appends
  // one character at a time. Returning those lines untouched is what keeps the
  // whole-tree counters (duplicate-token-blocks above all) affordable.
  if (!state.inTemplate && !QUOTE_CHARACTER.test(raw)) {
    return { code: raw, state: NO_OPEN_TEMPLATE };
  }

  let out = "";
  let i = 0;

  if (state.inTemplate) {
    const close = findUnescapedQuote(raw, 0, "`");
    if (close === -1) {
      return { code: out, state };
    }
    out += BLANKED_LITERAL;
    i = close + 1;
  }

  let inTemplate = false;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const close = findUnescapedQuote(raw, i + 1, ch);
      if (close === -1) {
        // Unterminated: a template literal legitimately continues on the
        // next line; an unterminated '/" is invalid JS, blank defensively.
        if (ch === "`") {
          inTemplate = true;
        }
        break;
      }
      out += BLANKED_LITERAL;
      i = close + 1;
      continue;
    }
    out += ch;
    i += 1;
  }

  return { code: out, state: { inTemplate } };
};

// Blank literals, then drop the trailing `//` comment. Order matters: doing
// this on the ORIGINAL line (as the counters used to) means a `//` inside a
// string (e.g. `const s = "http://x" as string;`) truncates the line before
// the string is ever recognized as a string, silently dropping real code
// (including real casts) after it. Stripping literals first fixes that.
const stripLine = (
  raw: string,
  state: LiteralScanState,
): { code: string; state: LiteralScanState } => {
  const { code, state: nextState } = stripStringLiterals(raw, state);
  return { code: code.replace(LINE_COMMENT_TAIL, ""), state: nextState };
};

const stripBlockComments = (
  code: string,
  inBlockComment: boolean,
): { code: string; inBlockComment: boolean } => {
  if (!inBlockComment && !code.includes("/*")) {
    return { code, inBlockComment: false };
  }

  let output = "";
  let cursor = 0;
  let inside = inBlockComment;
  while (cursor < code.length) {
    if (inside) {
      const close = code.indexOf("*/", cursor);
      if (close === -1) {
        return { code: output, inBlockComment: true };
      }
      cursor = close + 2;
      inside = false;
      continue;
    }
    const open = code.indexOf("/*", cursor);
    if (open === -1) {
      output += code.slice(cursor);
      break;
    }
    output += code.slice(cursor, open);
    cursor = open + 2;
    inside = true;
  }
  return { code: output, inBlockComment: inside };
};

const countAsCasts = (content: string): number => {
  let total = 0;
  let inModuleStmt = false;
  let inBlockComment = false;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code: lineCode, state } = stripLine(raw, literalState);
    literalState = state;
    const blockResult = stripBlockComments(lineCode, inBlockComment);
    const code = blockResult.code;
    inBlockComment = blockResult.inBlockComment;

    if (inModuleStmt) {
      if (MODULE_STMT_TERMINATOR.test(code)) {
        inModuleStmt = false;
      }
      continue;
    }
    if (COMMENT_LINE.test(code)) {
      continue;
    }
    if (MODULE_STMT_OPEN.test(code)) {
      if (!MODULE_STMT_TERMINATOR.test(code)) {
        inModuleStmt = true;
      }
      continue;
    }
    const scanned = code
      .replace(AS_UNKNOWN_AS, () => AS_UNKNOWN_PLACEHOLDER)
      .replace(
        MAPPED_TYPE_KEY_REMAP,
        (_match, mappedPrefix: string) =>
          `${mappedPrefix}${MAPPED_TYPE_REMAP_PLACEHOLDER}`,
      );
    total += (scanned.match(AS_CAST) ?? []).length;
  }
  return total;
};

const NULLISH_ARRAY = /\?\?\s*\[\]/gu;

// Same false-positive class as as-casts (a string/template can contain
// literal `?? []` text, e.g. an error message or doc example) and shares the
// stripLine helper by construction, so it gets the same fix for free.
const countNullishArrayFallback = (content: string): number => {
  let total = 0;
  let inBlockComment = false;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code: lineCode, state } = stripLine(raw, literalState);
    literalState = state;
    const blockResult = stripBlockComments(lineCode, inBlockComment);
    const code = blockResult.code;
    inBlockComment = blockResult.inBlockComment;
    if (COMMENT_LINE.test(code)) {
      continue;
    }
    total += (code.match(NULLISH_ARRAY) ?? []).length;
  }
  return total;
};

// The kind-bearing lucide glyphs `no-direct-entity-glyph` bans: drawing one
// by hand is a second entity-kind mapping, and every copy so far has drifted
// (only "folder" handled, or the kind guessed from a label). Matched as whole
// identifiers so both the import and the JSX use of a file that still draws
// its own count.
const ENTITY_GLYPH_IDENTIFIER = /\b(?:Folder|FolderOpen|ListTodo)(?:Icon)?\b/gu;

const countEntityKindGlyphs = (content: string): number => {
  let total = 0;
  let inBlockComment = false;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code: lineCode, state } = stripLine(raw, literalState);
    literalState = state;
    const blockResult = stripBlockComments(lineCode, inBlockComment);
    const code = blockResult.code;
    inBlockComment = blockResult.inBlockComment;
    if (COMMENT_LINE.test(code)) {
      continue;
    }
    total += (code.match(ENTITY_GLYPH_IDENTIFIER) ?? []).length;
  }
  return total;
};

// Oxlint owns precise syntax and scope enforcement for changed files. This
// migration-debt counter deliberately tracks only non-identifier throw shapes,
// preserving its established baseline without putting an AST parse in the
// ratchet's hot path.
const THROW_STATEMENT_START = /^\s*throw\b/u;
const THROW_PANIC_CALL = /^\s*throw\s+panic\s*\(/u;

const isAsciiIdentifierCodePoint = (codePoint: number): boolean =>
  (codePoint >= 48 && codePoint <= 57) ||
  (codePoint >= 65 && codePoint <= 90) ||
  codePoint === 95 ||
  codePoint === 36 ||
  (codePoint >= 97 && codePoint <= 122);

const isBareIdentifierThrow = (code: string): boolean => {
  const statement = code.trim();
  if (!statement.startsWith("throw")) {
    return false;
  }
  const expressionWithTerminator = statement.slice("throw".length).trim();
  const expression = expressionWithTerminator.endsWith(";")
    ? expressionWithTerminator.slice(0, -1).trim()
    : expressionWithTerminator;
  if (expression.length === 0) {
    return false;
  }
  const first = expression.codePointAt(0);
  if (first === undefined || (first >= 48 && first <= 57)) {
    return false;
  }
  for (let index = 0; index < expression.length; index += 1) {
    const codePoint = expression.codePointAt(index);
    if (codePoint === undefined || !isAsciiIdentifierCodePoint(codePoint)) {
      return false;
    }
  }
  return true;
};

const countThrowsOutsideBoundary = (content: string): number => {
  let total = 0;
  let inBlockComment = false;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code: lineCode, state } = stripLine(raw, literalState);
    literalState = state;
    const blockResult = stripBlockComments(lineCode, inBlockComment);
    const code = blockResult.code;
    inBlockComment = blockResult.inBlockComment;
    if (
      COMMENT_LINE.test(code) ||
      isBareIdentifierThrow(code) ||
      THROW_PANIC_CALL.test(code)
    ) {
      continue;
    }
    if (THROW_STATEMENT_START.test(code)) {
      total += 1;
    }
  }
  return total;
};

// A `catch` clause opener: `catch (e) {` or `catch {`, with or without the
// closing `}` of the `try` block on the same line. Requires `(` or `{`
// immediately (modulo whitespace) after `catch`, so an object key named
// `catch` — `Result.tryPromise({ try: ..., catch: (cause) => cause })` — is
// never mistaken for a clause: a key is always followed by `:`.
const isCatchClauseOpen = (code: string): boolean => {
  let remainder = code.trimStart();
  if (remainder.startsWith("}")) {
    remainder = remainder.slice(1).trimStart();
  }
  if (!remainder.startsWith("catch")) {
    return false;
  }
  const firstAfterCatch = remainder.slice("catch".length).trimStart().at(0);
  return firstAfterCatch === "(" || firstAfterCatch === "{";
};

const countTryCatchOutsideBoundary = (content: string): number => {
  let total = 0;
  let inBlockComment = false;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code: lineCode, state } = stripLine(raw, literalState);
    literalState = state;
    const blockResult = stripBlockComments(lineCode, inBlockComment);
    const code = blockResult.code;
    inBlockComment = blockResult.inBlockComment;
    if (COMMENT_LINE.test(code)) {
      continue;
    }
    if (isCatchClauseOpen(code)) {
      total += 1;
    }
  }
  return total;
};

const countMatches = (content: string, pattern: RegExp): number =>
  (content.match(pattern) ?? []).length;

const LEGACY_REALTIME_INVALIDATION_PRODUCER =
  /(?:["']invalidate-query["']|\bREALTIME_EVENT_TYPE\.INVALIDATE_QUERY\b|\binvalidate(?:Organization)?Query\s*:\s*true\b|\bbroadcast(?:QueryInvalidationTo(?:Organization|TargetWorkspace)|Invalidation)\s*\()/gu;

const countLegacyRealtimeInvalidationProducers = (content: string): number =>
  countMatches(stripComments(content), LEGACY_REALTIME_INVALIDATION_PRODUCER);

// Preserve strings, templates, and regex literals because some shared-helper
// metrics inspect import sources and SQL literals. Only parser-recognized
// comment trivia is blanked, with line breaks retained so tokens cannot join.
const stripComments = (content: string): string => {
  const sourceFile = ts.createSourceFile(
    "ratchet-comments.tsx",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const ranges = new Map<number, ts.CommentRange>();
  const collect = (comments: readonly ts.CommentRange[] | undefined): void => {
    for (const comment of comments ?? []) {
      ranges.set(comment.pos, comment);
    }
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(content, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(content, node.getEnd()));
    for (const child of node.getChildren(sourceFile)) {
      visit(child);
    }
  };
  visit(sourceFile);

  let output = "";
  let previousEnd = 0;
  for (const range of [...ranges.values()].sort(
    (left, right) => left.pos - right.pos,
  )) {
    if (range.pos < previousEnd) {
      continue;
    }
    output += content.slice(previousEnd, range.pos);
    output += content.slice(range.pos, range.end).replace(/[^\r\n]/gu, " ");
    previousEnd = range.end;
  }
  return output + content.slice(previousEnd);
};

const importedLocalBindings = (
  content: string,
  moduleName: string,
  importedName: string,
): Set<string> => {
  const bindings = new Set([importedName]);
  const sourceFile = ts.createSourceFile(
    "ratchet-source.tsx",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName
    ) {
      continue;
    }
    const bindingsNode = statement.importClause?.namedBindings;
    if (!bindingsNode || !ts.isNamedImports(bindingsNode)) {
      continue;
    }
    for (const specifier of bindingsNode.elements) {
      if ((specifier.propertyName ?? specifier.name).text === importedName) {
        bindings.add(specifier.name.text);
      }
    }
  }
  return bindings;
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// Fuzzy supersets for narrow shared-helper/component bans. These counters are
// intentionally lexical: the AST rules reject the exact known-bad shapes,
// while the ratchets keep nearby aliases and new spellings visible in review.
const countHandRolledUserIdentity = (content: string): number =>
  countMatches(stripComments(content), /<UserAvatar\b/gu);

// Both the flat subpath and the deprecated grouped alias reach the same
// module, so the metric counts either spelling.
const countRawUserAvatarPrimitive = (content: string): number =>
  countMatches(
    stripComments(content),
    /["']@stll\/ui\/(?:components\/)?avatar["']/gu,
  );

const countShadowedUserNameHelpers = (content: string): number =>
  countMatches(
    stripComments(content),
    /\b(?:const|function)\s+(?:getDisplayName|getInitials)\b/gu,
  );

const countAdHocRelativeTimeFormatting = (content: string): number => {
  const code = stripComments(content);
  const fullTimestampBindings = importedLocalBindings(
    code,
    "@/lib/relative-time",
    "formatFullTimestamp",
  );
  const nativeTitleCount = [...fullTimestampBindings].reduce(
    (total, binding) =>
      total +
      countMatches(
        code,
        new RegExp("title=\\{" + escapeRegExp(binding) + "\\s*\\(", "gu"),
      ),
    0,
  );
  return (
    nativeTitleCount +
    countMatches(
      code,
      /\{(?=[^{}]*\bdateStyle\s*:)(?=[^{}]*\btimeStyle\s*:)[^{}]*\}/gsu,
    )
  );
};

const countDirectAuditLogInserts = (content: string): number => {
  const code = stripComments(content);
  const auditLogBindings = importedLocalBindings(
    code,
    "@/api/db/schema",
    "auditLogs",
  );
  return [...auditLogBindings].reduce(
    (total, binding) =>
      total +
      countMatches(
        code,
        new RegExp(
          "\\.insert\\s*\\(\\s*" + escapeRegExp(binding) + "\\s*\\)",
          "gu",
        ),
      ),
    0,
  );
};

const countInlineTimestampCursorSql = (content: string): number =>
  countMatches(
    stripComments(content),
    /YYYY-MM-DD"T"HH24:MI:SS\.US(?!"Z")|::\s*timestamp\s+AT\s+TIME\s+ZONE\s*['"]UTC['"]/giu,
  );

/**
 * Direct `isRedistributable(x)` calls, counted from the syntax tree.
 *
 * A text scan cannot tell a call from a mention: it counts the word inside a
 * comment explaining the gate, inside a string, and `source.isRedistributable(...)`
 * on some unrelated object. This counts a call whose callee is the bare
 * identifier — the shape the gate replaced — and nothing else.
 */
const countDirectRedistributableCalls = (content: string): number => {
  const sourceFile = ts.createSourceFile(
    "ratchet-source.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  let total = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "isRedistributable"
    ) {
      total += 1;
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return total;
};

const countRepeatedTimestampCursorBoundaries = (content: string): number => {
  const code = stripComments(content);
  const sourceFile = ts.createSourceFile(
    "ratchet-source.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const boundaryBindings = importedLocalBindings(
    code,
    "@/api/lib/db-pagination",
    "pgTimestampCursorBoundary",
  );
  const orBindings = importedLocalBindings(code, "drizzle-orm", "or");

  const countBoundaries = (node: ts.Node): number => {
    let count =
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      boundaryBindings.has(node.expression.text)
        ? 1
        : 0;
    node.forEachChild((child) => {
      count += countBoundaries(child);
    });
    return count;
  };

  let total = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      orBindings.has(node.expression.text)
    ) {
      total += Math.max(0, countBoundaries(node) - 1);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return total;
};

/**
 * Regex literals whose worst case backtracks super-linearly in the length of
 * the subject — the shape that turns one oversized input into minutes of
 * blocking CPU on a single-threaded runtime.
 *
 * `scslre` is the analyser behind eslint-plugin-regexp's super-linear rules.
 * It reports both flavours, and both matter here: `Trade` (the pattern
 * re-splits the same text against itself) and `Move` (each retry of the whole
 * pattern re-walks what the previous one consumed). The second reads as
 * harmless and is not — it is the shape that stalls a document parser.
 *
 * This is the one counter that parses rather than scanning lines. The
 * line-based approach is not merely approximate here, it is blind in exactly
 * the wrong direction: the shared literal-blanking pass reads the `"` inside
 * `/\s*scale="[^"]*"/u` as opening a string and eats the rest of the pattern,
 * so a regex is hidden by the very characters that make it worth checking. A
 * guard a new regex can evade by containing a quote is not a guard.
 */
const countSuperLinearRegexes = (content: string, file: string): number => {
  // Pick the dialect from the extension. TSX for every file would
  // misread a generic arrow such as `<Ts>(…) =>` in a .ts file as JSX,
  // and the parser's recovery can swallow the rest of the file — which
  // would silently hide regexes from a guard whose whole value is that
  // it cannot be evaded.
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  let total = 0;
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const literal = node.getText(source);
      const lastSlash = literal.lastIndexOf("/");
      let expression: RegExp;
      try {
        expression = new RegExp(
          literal.slice(1, lastSlash),
          literal.slice(lastSlash + 1),
        );
      } catch {
        // A pattern this runtime cannot compile cannot run either.
        return;
      }
      try {
        if (analyse(expression).reports.length > 0) {
          total += 1;
        }
      } catch {
        // The analyser bails on constructs it does not model; an
        // unanalysable pattern is not evidence of a finding.
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return total;
};

const DIRECT_ERROR_MESSAGE =
  /\berror\s+instanceof\s+Error\s*\?\s*error\.message\b|\berror\.message\s*\?\?|\bresult\.error\.message\s*\?\?|\bAPIError\.is\([^)]*\)\s*&&[\s\S]{0,120}?\berror\.message\b/gu;

const countDirectErrorMessageDisplay = (content: string): number => {
  const strippedLines: string[] = [];
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code, state } = stripLine(raw, literalState);
    literalState = state;
    if (COMMENT_LINE.test(code)) {
      strippedLines.push("");
      continue;
    }
    strippedLines.push(code);
  }

  const strippedContent = strippedLines.join("\n");
  return (strippedContent.match(DIRECT_ERROR_MESSAGE) ?? []).length;
};

// Barrel files are selected by the include glob; every matched file counts as
// one barrel (presence metric).
const countPresence = (): number => 1;

// A module-scope `const`/`let` assigned `new Map(...)`/`new Set(...)`, i.e. a
// mutable collection that lives for the lifetime of the module (a tab can
// keep it open for days), never anchored to a component lifecycle. `\b`
// after `Map`/`Set` deliberately does NOT match `WeakMap`/`WeakSet` — those
// are GC-safe by construction (keys drop out once nothing else references
// them) and are excluded from this metric on purpose. A binding typed
// `ReadonlySet`/`ReadonlyMap` is excluded too: the type strips `add`/`set`/
// `delete`, so nothing can turn it into a registry without an `as` cast, which
// the as-casts metric holds at zero. The `^` anchor (no leading whitespace) is
// the "module scope, not inside a function" heuristic: a declaration indented
// under a function/hook is scoped to that call, not the module.
const MODULE_MUTABLE_COLLECTION =
  /^(?:export\s+)?(?:const|let)\s+\w+\s*(?::(?!\s*Readonly(?:Map|Set)\b).+?)?=\s*new\s+(?:Map|Set)\b/u;

const countModuleLevelMutableCollections = (content: string): number => {
  let total = 0;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code, state } = stripLine(raw, literalState);
    literalState = state;
    if (COMMENT_LINE.test(code)) {
      continue;
    }
    if (MODULE_MUTABLE_COLLECTION.test(code)) {
      total += 1;
    }
  }
  return total;
};

// Suppression budgets are a partition: each disable directive is charged to
// exactly one budget, so no rule's improvement can fund another rule's new
// waiver. `scripts/lint-suppressions.ts` owns the tracked-rule table and the
// directive scanner; the same module backs the security-tier waiver ledger, so
// budget and ledger can never disagree about what a suppression is.
const countTrackedRuleSuppressions =
  (rule: string): FileCounter =>
  (content, file) =>
    collectLintDirectives(content, file).filter((directive) =>
      suppressesRule(directive, rule),
    ).length;

// The residual budget: directives naming only rules with no dedicated budget.
// A bare directive is excluded here because it silences every tracked rule and
// is already charged to each of their budgets.
const countResidualLintSuppressions = (content: string, file: string): number =>
  collectLintDirectives(content, file).filter(isResidualDirective).length;

// A compiler-suppression directive. Fidelity limit: a prose comment that
// STARTS with the directive token (`// @ts-expect-error is bad`) counts, one
// that merely mentions it mid-sentence does not; directives and leading
// mentions are lexically identical, and the noise is stable so the ratchet
// still only moves on real changes.
const TS_SUPPRESSION_DIRECTIVE =
  /(?:\/\/|\/\*)\s*@ts-(?:expect-error|ignore|nocheck)\b/u;

const countTsSuppressions = (content: string): number => {
  let total = 0;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code, state } = stripStringLiterals(raw, literalState);
    literalState = state;
    if (TS_SUPPRESSION_DIRECTIVE.test(code)) {
      total += 1;
    }
  }
  return total;
};

// Explicitly detached calls bypass no-floating-promises when `void` is
// accepted, while async JSX handlers bypass no-misused-promises because JSX
// attributes are intentionally disabled there. Both shapes require review:
// some callees handle failures internally or are synchronous despite the
// syntax, while others can turn a rejection into an unhandled-rejection event.
// This lexical rollout freezes review debt without pretending to infer types.
// A terminal `.catch(...)` on the same line is treated as handled;
// `.finally(...)` is not, because its returned promise can still reject.
const VOID_DETACHED_CALL = /\bvoid\s+(?=[(A-Za-z_$])/gu;
const ASYNC_JSX_HANDLER = /\bon[A-Z][\w$]*\s*=\s*\{\s*async\b/gu;
const TERMINAL_CATCH = /\.catch\s*\(/u;

const countUnhandledDetachedPromises = (content: string): number => {
  let total = 0;
  let inBlockComment = false;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code: lineCode, state } = stripLine(raw, literalState);
    literalState = state;
    const blockResult = stripBlockComments(lineCode, inBlockComment);
    const code = blockResult.code;
    inBlockComment = blockResult.inBlockComment;
    if (COMMENT_LINE.test(code)) {
      continue;
    }

    total += (code.match(ASYNC_JSX_HANDLER) ?? []).length;
    if (!TERMINAL_CATCH.test(code)) {
      total += (code.match(VOID_DETACHED_CALL) ?? []).length;
    }
  }
  return total;
};

// --- Cross-slice import counters ---------------------------------------------
// Vertical slices (AGENTS.md): API handler domains, web route dirs (their
// `-`-prefixed route-private paths), and web feature dirs are independent
// end-to-end slices; an import reaching across them couples slices. These
// counters extract module specifiers per line and resolve them against the
// importing file's path. Deliberately NOT literal-stripped: import specifiers
// ARE string literals. Fidelity limits: the specifier must sit on the same
// line as its `from`/`import(`/`import` keyword (oxfmt formats imports that
// way), and an import-shaped string inside a template literal would count
// (stable noise; none today).
const MODULE_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/gu;

const API_HANDLERS_PREFIX = "apps/api/src/handlers/";
const API_LIB_PREFIX = "apps/api/src/lib/";
const WEB_ROUTES_PREFIX = "apps/web/src/routes/";
const WEB_FEATURES_PREFIX = "apps/web/src/features/";
const WEB_ALIAS_PREFIX = "@/";
const WEB_ALIAS_ROOT = "apps/web/src";

const API_ALIAS_PREFIX = "@/api/";
const API_ALIAS_ROOT = "apps/api/src";

// Repo-relative path a specifier resolves to, or null for package imports.
// `@/api/*` must resolve before the generic `@/` prefix: BOTH apps alias it
// to apps/api/src (api's own tsconfig and web's Eden path), so treating it as
// a web path would silently miss every alias-form cross-handler import.
const resolveSpecifier = (file: string, spec: string): string | null => {
  if (spec.startsWith(API_ALIAS_PREFIX)) {
    return path.posix.join(API_ALIAS_ROOT, spec.slice(API_ALIAS_PREFIX.length));
  }
  if (spec.startsWith(WEB_ALIAS_PREFIX)) {
    return path.posix.join(WEB_ALIAS_ROOT, spec.slice(WEB_ALIAS_PREFIX.length));
  }
  if (spec.startsWith(".")) {
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(file), spec),
    );
  }
  return null;
};

// Truncate `raw` at a trailing `//` comment without blanking string literals
// (import specifiers ARE strings, so stripLine cannot be reused here). Walks
// the line with quote state; a `//` inside a quoted literal survives.
// Per-line only: template-literal state is not carried across lines, which is
// fine for import extraction (an import statement never sits inside one).
const truncateAtLineComment = (raw: string): string => {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      return raw.slice(0, i);
    }
  }
  return raw;
};

// First path segment of `p` after `prefix` (the slice name), or null when `p`
// is not under `prefix`.
const sliceOf = (p: string, prefix: string): string | null => {
  if (!p.startsWith(prefix)) {
    return null;
  }
  const segment = p.slice(prefix.length).split("/").at(0);
  return segment !== undefined && segment.length > 0 ? segment : null;
};

// Path remainder inside a slice (`""` when the specifier targets the slice
// root itself, e.g. `../skills` — which is either a loose shared FILE under
// the prefix or a barrel import; neither resolvable without the filesystem,
// both excluded on purpose).
const restWithinSlice = (p: string, prefix: string, slice: string): string =>
  p.slice(Math.min(p.length, prefix.length + slice.length + 1));

type CrossSliceRule = (file: string, resolved: string) => boolean;

const crossesHandlerDomain: CrossSliceRule = (file, resolved) => {
  const from = sliceOf(file, API_HANDLERS_PREFIX);
  const to = sliceOf(resolved, API_HANDLERS_PREFIX);
  if (from === null || to === null || to === from) {
    return false;
  }
  return restWithinSlice(resolved, API_HANDLERS_PREFIX, to).length > 0;
};

const crossesLibToHandler: CrossSliceRule = (file, resolved) =>
  file.startsWith(API_LIB_PREFIX) && resolved.startsWith(API_HANDLERS_PREFIX);

// `-`-prefixed segments are route-private by TanStack convention; reaching
// one from outside its TOP-LEVEL route dir (nested dirs like
// `_protected.workspaces/$workspaceId/...` belong to `_protected.workspaces`)
// couples route slices.
const ROUTE_PRIVATE_SEGMENT = /(?:^|\/)-/u;

const crossesRoutePrivate: CrossSliceRule = (file, resolved) => {
  const to = sliceOf(resolved, WEB_ROUTES_PREFIX);
  if (to === null) {
    return false;
  }
  const rest = restWithinSlice(resolved, WEB_ROUTES_PREFIX, to);
  if (!ROUTE_PRIVATE_SEGMENT.test(rest)) {
    return false;
  }
  // A file directly under routes/ (routes/dev.tsx) IS the route whose
  // children live in the same-named dir (routes/dev/): strip its extension
  // so the route file's own `-`-private imports stay same-slice. A parent
  // layout (_protected.tsx) reaching into a CHILD route dir
  // (_protected.chat/) still differs after the strip and still counts.
  const from = sliceOf(file, WEB_ROUTES_PREFIX)?.replace(/\.tsx?$/u, "");
  return from !== to;
};

const crossesFeature: CrossSliceRule = (file, resolved) => {
  const from = sliceOf(file, WEB_FEATURES_PREFIX);
  const to = sliceOf(resolved, WEB_FEATURES_PREFIX);
  return from !== null && to !== null && to !== from;
};

const countCrossSliceImports =
  (crosses: CrossSliceRule): FileCounter =>
  (content, file) => {
    let total = 0;
    for (const raw of content.split("\n")) {
      if (COMMENT_LINE.test(raw)) {
        continue;
      }
      const code = truncateAtLineComment(raw);
      for (const match of code.matchAll(MODULE_SPECIFIER)) {
        const spec = match[1];
        if (spec === undefined) {
          continue;
        }
        const resolved = resolveSpecifier(file, spec);
        if (resolved !== null && crosses(file, resolved)) {
          total += 1;
        }
      }
    }
    return total;
  };

// --- Metric table -----------------------------------------------------------

// A capability whose input schema exceeded the exporter's byte cap
// (`MAX_CAPABILITY_SCHEMA_BYTES` in apps/api/scripts/lib/capability-catalog.ts).
// A capability whose schema was dropped for size degraded to an opaque
// `--input` JSON blob: no typed CLI flags, no discoverable shape, and nothing
// failed to say so. The exporter no longer has that escape hatch — it hoists
// repeated subschemas into `$defs` and errors on anything still over the byte
// cap — so this counter now guards the absence of the pathway rather than
// burning it down. Counting the committed artifact (rather than re-running the
// exporter) keeps the scan cheap and deterministic.
const countTruncatedCapabilitySchemas = (content: string): number => {
  const parsed: unknown = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    return 0;
  }
  return parsed.filter(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "inputSchemaTruncated" in entry &&
      entry.inputSchemaTruncated === true,
  ).length;
};

// Capabilities carrying no authored `description` are tracked by exact id in
// apps/api/capability-description-ledger.json, not by an aggregate count here:
// see apps/api/scripts/capability-description-guard.ts. Any set of the same
// size satisfies a count, so it could not name the gap an author had just
// closed, nor force that entry to be deleted in the same change as the prose.

// A capability suppressed from the generic transport by its `transport`
// disposition: it returns bytes (`file-response`/`file-both`), or it REQUIRES a
// file input. Suppressed entries are dropped from the CLI tree
// (`insertCapabilities`) and refused pre-execution by `invoke_capability`, so
// each one is a capability an agent surface simply cannot reach. This metric
// freezes that count: a newly file-shaped capability cannot silently disappear
// from both clients, and the burn-down is a reviewed baseline bump rather than a
// side effect. A capability with an OPTIONAL file input is NOT counted — its
// JSON modes stay invokable (the file field is withheld), which is the shape of
// a real burn-down rather than a relabelling. The unit is a suppressed
// capability, so an entry blocked on both legs counts once. Counting the
// committed artifact keeps the scan cheap and deterministic.
const countFileTransportSuppressed = (content: string): number => {
  const parsed: unknown = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    return 0;
  }
  return parsed.filter((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const transport: unknown = Object.hasOwn(entry, "transport")
      ? Object.getOwnPropertyDescriptor(entry, "transport")?.value
      : undefined;
    if (typeof transport !== "object" || transport === null) {
      return false;
    }
    const type: unknown = Object.getOwnPropertyDescriptor(
      transport,
      "type",
    )?.value;
    if (type === "file-response" || type === "file-both") {
      return true;
    }
    if (type !== "file-input") {
      return false;
    }
    const input: unknown = Object.getOwnPropertyDescriptor(
      transport,
      "input",
    )?.value;
    if (typeof input !== "object" || input === null) {
      return false;
    }
    return Object.getOwnPropertyDescriptor(input, "required")?.value === true;
  }).length;
};

// A READ capability that requires a write-only OAuth grant is unreachable by a
// read-only credential
// (`stella:read` / `stella:admin_read`): the exporter's read-scope guard
// prevents it, and this ratchet freezes the count at 0 over the committed
// catalog so a regression fails CI even if the exporter guard were bypassed
// (e.g. a hand-edited JSON). The scope classification is shared with the
// exporter, so the guard cannot omit a newly classified write-only scope.
const WRITE_ONLY_SCOPES: ReadonlySet<string> = new Set(
  MCP_WRITE_ONLY_RESOURCE_SCOPES,
);

const countReadCapabilitiesWithWriteScope = (content: string): number => {
  const parsed: unknown = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    return 0;
  }
  return parsed.filter((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const read = (key: string): unknown =>
      Object.hasOwn(entry, key)
        ? Object.getOwnPropertyDescriptor(entry, key)?.value
        : undefined;
    const scope = read("scope");
    return (
      read("access") === "read" &&
      typeof scope === "string" &&
      WRITE_ONLY_SCOPES.has(scope)
    );
  }).length;
};

/**
 * Entries in the reviewed `DOMAIN_ACTION_VERBS` allowlist: capability action
 * verbs outside the canonical `list/get/create/update/delete` set. Each one is a
 * public command verb a caller has to learn, so the list may only shrink —
 * typically by splitting a compound verb into a nested resource directory
 * (`clauses/categories/create.ts` over `clauses/categories-create.ts`).
 */
const countDomainActionVerbs = (content: string): number => {
  const block =
    /export const DOMAIN_ACTION_VERBS = new Set\(\[([\s\S]*?)\]\);/u.exec(
      content,
    )?.[1];
  return block === undefined ? 0 : (block.match(/^[ \t]*"/gmu) ?? []).length;
};

/**
 * Namespaces where a curated, hand-written command still shares a top-level name
 * with generated capability commands, so `stella <namespace> …` mixes the named
 * MCP tool path and the generic `invoke_capability` path. Must reach zero.
 */
const countShadowedNamespaces = (content: string): number => {
  const block =
    /const SHADOWED_NAMESPACE_ALLOWLIST: readonly string\[\] = \[([\s\S]*?)\];/u.exec(
      content,
    )?.[1];
  return block === undefined ? 0 : (block.match(/^[ \t]*"/gmu) ?? []).length;
};

const PG_TABLE_MARKER = "p.pgTable(";
const WORKSPACE_ONLY_POLICIES_MARKER = "...wsPolicies()";
const ORGANIZATION_ID_COLUMN_MARKER = "organizationId:";

// Offsets of every occurrence of `marker`, left to right.
const markerOffsets = (source: string, marker: string): number[] => {
  const offsets: number[] = [];
  let offset = source.indexOf(marker);
  while (offset !== -1) {
    offsets.push(offset);
    offset = source.indexOf(marker, offset + marker.length);
  }
  return offsets;
};

// True when some occurrence of `marker` opens a line, i.e. only indentation
// precedes it. Distinguishes a property declaration from the same identifier
// appearing mid-expression.
const hasLineLeadingMarker = (source: string, marker: string): boolean =>
  markerOffsets(source, marker).some((offset) => {
    let start = offset;
    while (
      start > 0 &&
      (source[start - 1] === " " || source[start - 1] === "\t")
    ) {
      start -= 1;
    }
    return start === 0 || source[start - 1] === "\n";
  });

/**
 * Tables that persist an `organization_id` alongside `workspace_id` but
 * authorize rows with `wsPolicies()`, which pins only the workspace. The
 * org-pinned form `wsOrganizationPolicies("<table>")` requires both scopes in
 * every command, so a row whose `organization_id` disagrees with the
 * transaction's tenant stays unreachable however its workspace was authorized.
 * A table with no `organization_id` column has nothing to pin and is not
 * counted; adding the column to such a table is a schema decision, not a
 * policy one. Must stay at zero.
 *
 * Plain substring scanning throughout: the declaration boundaries and both
 * markers are fixed strings, so no pattern here can backtrack.
 */
const countWorkspaceOnlyRlsOnOrgTables = (content: string): number => {
  const source = stripComments(content);
  const starts = markerOffsets(source, PG_TABLE_MARKER);

  let count = 0;
  for (const [index, start] of starts.entries()) {
    const body = source.slice(start, starts[index + 1] ?? source.length);
    if (
      body.includes(WORKSPACE_ONLY_POLICIES_MARKER) &&
      hasLineLeadingMarker(body, ORGANIZATION_ID_COLUMN_MARKER)
    ) {
      count += 1;
    }
  }
  return count;
};

const LEGACY_MANUAL_MCP_INPUT_SCHEMA_ALLOWLIST =
  "MCP_LEGACY_MANUAL_INPUT_SCHEMA_TOOL_NAMES";

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

/**
 * Entries in the explicit legacy native-MCP input-schema inventory. Each entry
 * is a tool whose hand-authored JSON Schema still mirrors a separate runtime
 * validator; the count may only shrink as tools move to Valibot-derived wire
 * schemas. Parse the exact declaration so comments and unrelated arrays cannot
 * buy or consume this debt budget.
 */
const countLegacyManualMcpInputSchemas = (
  content: string,
  file: string,
): number => {
  const sourceFile = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== LEGACY_MANUAL_MCP_INPUT_SCHEMA_ALLOWLIST
      ) {
        continue;
      }
      if (declaration.initializer === undefined) {
        return panic(
          `${LEGACY_MANUAL_MCP_INPUT_SCHEMA_ALLOWLIST} must have an array initializer`,
        );
      }
      const initializer = unwrapExpression(declaration.initializer);
      if (!ts.isArrayLiteralExpression(initializer)) {
        return panic(
          `${LEGACY_MANUAL_MCP_INPUT_SCHEMA_ALLOWLIST} must be an array literal`,
        );
      }
      for (const element of initializer.elements) {
        if (!ts.isStringLiteralLike(element)) {
          return panic(
            `${LEGACY_MANUAL_MCP_INPUT_SCHEMA_ALLOWLIST} must contain only string literals`,
          );
        }
      }
      return initializer.elements.length;
    }
  }

  return panic(
    `${LEGACY_MANUAL_MCP_INPUT_SCHEMA_ALLOWLIST} is missing from ${file}`,
  );
};

type FileCounter = (content: string, file: string) => number;

// A repo metric answers a question no single file can — the same helper copied
// into two apps, one name defined in two workspaces, the size of a flat
// catch-all directory — so it walks the tree itself. It returns the same
// per-file breakdown a file metric produces, which keeps the baseline shape,
// the diff, and the regression report identical for both scopes.
type RepoMetricResult = {
  readonly count: number;
  readonly files: Record<string, number>;
};

type RepoCounter = (root: string) => RepoMetricResult;

type RatchetMetric =
  | {
      readonly scope: "file";
      readonly id: string;
      readonly description: string;
      readonly include: readonly string[];
      readonly exclude: (file: string) => boolean;
      readonly count: FileCounter;
    }
  | {
      readonly scope: "repo";
      readonly id: string;
      readonly description: string;
      readonly count: RepoCounter;
    };

// One decrease-only budget per tracked rule, derived from the single
// tracked-rule table rather than hand-listed here: a rule added to that table
// cannot be forgotten in the metric registry, and the residual budget's
// subtraction always matches the set of budgets that exist.
//
// Scope is every hand-written source file in the repo, not just the two big
// apps. A security waiver in an operational script stands down the same
// invariant as one in a handler, and the rules are enabled well beyond
// `apps/*/src` in `oxlint.config.ts`.
// The `test-integrity` tier budgets rules oxlint enables only on tests, so its
// scan has to keep test files; every other tier guards product code, where a
// directive in a test is noise.
const PER_RULE_SUPPRESSION_METRICS: readonly RatchetMetric[] =
  TRACKED_SUPPRESSION_RULES.map(({ rule, tier, guards }) => ({
    scope: "file",
    id: suppressionMetricId(rule),
    description: `${rule} disable directives, repo-wide (${tier} tier: ${guards}). Bare directives count, because they silence this rule too.`,
    include: ALL_SOURCE_GLOBS,
    exclude:
      tier === "test-integrity"
        ? isExcludedTestInclusiveSource
        : isExcludedSource,
    count: countTrackedRuleSuppressions(rule),
  }));

// Grandfathered `mock.module` targets: one ledger line per
// "<test file>::<workspace module>" pair. The rule
// (.oxlint-plugins/no-internal-module-mock.ts) reports an unlisted pair and a
// listed pair whose mock is gone; this budget is what stops a new pair from
// being listed instead of fixed.
const countInternalModuleMockLedgerEntries: FileCounter = (content) => {
  const parsed: unknown = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    panic("internal-module-mock ledger must be a JSON array");
  }
  return parsed.length;
};

// --- Repo-scope counters ----------------------------------------------------
// Duplication is invisible to a per-file counter: the second copy of a helper
// is a perfectly ordinary file. These counters compare files against each
// other, and measure the flat buckets a copy lands in when extracting a package
// feels expensive.

const APP_LIB_GLOB = "apps/*/src/lib/**/*.{ts,tsx}";
const WORKSPACE_OWNED_GLOBS = [
  APP_LIB_GLOB,
  "packages/*/src/**/*.{ts,tsx}",
] as const;
const API_LIB_DIR = "apps/api/src/lib";
const WEB_LIB_DIR = "apps/web/src/lib";
// Direct children that hold test scaffolding rather than product code: the
// bucket metric counts what a domain directory or a package would own.
const NON_PRODUCT_LIB_ENTRIES = new Set(["__fixtures__", "__tests__", "tests"]);

// `apps/web`, `packages/ui`: the workspace a file belongs to.
const workspaceOf = (rel: string): string =>
  rel.split("/").slice(0, 2).join("/");

const scanRepoFiles = (
  root: string,
  globs: readonly string[],
): readonly string[] => {
  const seen = new Set<string>();
  for (const glob of globs) {
    for (const rel of new Bun.Glob(glob).scanSync(root)) {
      if (!isExcludedSource(rel)) {
        seen.add(rel);
      }
    }
  }
  return [...seen].sort();
};

// Every file whose path below `src/lib` also exists under another app's
// `src/lib`, both sides included: a copy is two files, and either one may be
// the one deleted. The key is the path, not the basename: `lib/collation.ts` in
// two apps is one helper twice, while `lib/knowledge/types.ts` and
// `lib/chat/types.ts` are two domains sharing a convention name.
const LIB_SEGMENT = "/src/lib/";

const countCrossAppLibPathCopies: RepoCounter = (root) => {
  const byLibPath = new Map<string, Map<string, string[]>>();
  for (const rel of scanRepoFiles(root, [APP_LIB_GLOB])) {
    const libPath = rel.slice(rel.indexOf(LIB_SEGMENT) + LIB_SEGMENT.length);
    const app = workspaceOf(rel);
    const byApp = byLibPath.get(libPath) ?? new Map<string, string[]>();
    const copies = byApp.get(app) ?? [];
    copies.push(rel);
    byApp.set(app, copies);
    byLibPath.set(libPath, byApp);
  }

  const files: Record<string, number> = {};
  let count = 0;
  for (const byApp of byLibPath.values()) {
    if (byApp.size < 2) {
      continue;
    }
    for (const copies of byApp.values()) {
      for (const rel of copies) {
        files[rel] = 1;
        count += 1;
      }
    }
  }
  return { count, files };
};

// A top-level exported binding. Line-anchored, so a nested or re-exported
// declaration is not a definition this metric owns. Known limit, in the spirit
// of the counters above: an unindented `export const X` inside a block comment
// or a template literal reads as a definition.
const TOP_LEVEL_EXPORTED_BINDING =
  /^export\s+(?:async\s+)?(?:const|function|class|type|interface)\s+(?<name>[A-Za-z_$][\w$]*)/gmu;
// Short names (`id`, `Row`, `env`) collide by accident, not by duplication.
const MIN_DUPLICATE_EXPORT_NAME_LENGTH = 4;

// One name defined in N workspaces costs N-1: one workspace owns it, every
// other definition is the copy that should have imported it instead.
const countCrossWorkspaceDuplicateExportNames: RepoCounter = (root) => {
  const definitions = new Map<string, Map<string, string>>();
  for (const rel of scanRepoFiles(root, WORKSPACE_OWNED_GLOBS)) {
    // A name emitted by a code generator is the generator's to deduplicate.
    if (rel.includes("/generated/")) {
      continue;
    }
    const content = readFileSync(path.join(root, rel), "utf-8");
    for (const match of content.matchAll(TOP_LEVEL_EXPORTED_BINDING)) {
      const name = match.groups?.["name"] ?? "";
      if (name.length < MIN_DUPLICATE_EXPORT_NAME_LENGTH) {
        continue;
      }
      const byWorkspace = definitions.get(name) ?? new Map<string, string>();
      // Files arrive sorted, so the first file a workspace defines the name in
      // is the one the extra is attributed to.
      if (!byWorkspace.has(workspaceOf(rel))) {
        byWorkspace.set(workspaceOf(rel), rel);
      }
      definitions.set(name, byWorkspace);
    }
  }

  const files: Record<string, number> = {};
  let count = 0;
  for (const byWorkspace of definitions.values()) {
    const workspaces = [...byWorkspace.keys()].sort();
    for (const workspace of workspaces.slice(1)) {
      const rel =
        byWorkspace.get(workspace) ??
        panic(`ratchet lost the defining file for ${workspace}`);
      files[rel] = (files[rel] ?? 0) + 1;
      count += 1;
    }
  }
  return { count, files };
};

// Direct children of a flat lib bucket, one per entry: the bucket's size is the
// metric, so a new file and a new directory cost the same.
const countLibTopLevelEntries =
  (libDir: string): RepoCounter =>
  (root) => {
    const dir = path.join(root, libDir);
    if (!existsSync(dir)) {
      return { count: 0, files: {} };
    }
    const files: Record<string, number> = {};
    let count = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${libDir}/${entry.name}`;
      if (NON_PRODUCT_LIB_ENTRIES.has(entry.name) || isExcludedSource(rel)) {
        continue;
      }
      files[rel] = 1;
      count += 1;
    }
    return { count, files };
  };

// --- Duplicate token blocks -------------------------------------------------
// A copy-paste detector, in-house because a stock one over this whole tree ran
// for fifteen minutes without finishing. Stock detectors parse; this one is
// lexical. Blank comments and literal CONTENTS, split what is left into
// identifier and number tokens, and compare a rolling window of 60 tokens
// against every window seen before it. Punctuation is discarded with the
// structure: a run that differs only in brackets is still the same copy.
//
// Two windows match only when both rolling hashes agree AND the token sequences
// behind them are identical. The hashes narrow the search; they do not decide
// it. They cannot: both roll over the same per-token hash, so one colliding
// pair of identifiers (`contributorLastActivityMs` and `inspectedManifest`
// hash alike) would defeat both at once. Both sides of a confirmed match are
// charged: the earlier copy is as deletable as the later one, and which one
// survives is the author's call.
//
// Known limits, in the spirit of the counters above: a window that spans a
// literal matches on the code around it, and a clone shorter than 60 tokens is
// below the floor on purpose — short repeated shapes are idiom, not debt.

const CLONE_WINDOW_TOKENS = 60;
// Past this size a file is vendored, packed, or a data blob: tokenising it
// costs more than the copies it could reveal.
const MAX_CLONE_SCAN_BYTES = 300 * 1024;
const CLONE_TOKEN = /[A-Za-z_$][\w$]*|\d+/gu;
// Two polynomial bases over the same token ids, evaluated side by side.
const CLONE_BASE_PRIMARY = 16_777_619;
const CLONE_BASE_SECONDARY = 104_729;

const clonePower = (base: number, exponent: number): number => {
  let result = 1;
  for (let index = 0; index < exponent; index += 1) {
    result = Math.imul(result, base);
  }
  return result;
};

// Comment- and literal-free tokens for one file, as INTERNED ids: one id per
// distinct token text, shared across the whole scan. Ids rather than hashes,
// because equal ids then mean equal text — a token hash would let one collision
// (`contributorLastActivityMs` and `inspectedManifest` hash alike) read as a
// repeated identifier. The strip is the same line-based one the other counters
// use, so a `//` inside a string cannot truncate real code.
const cloneTokensOf = (
  content: string,
  cache: Map<string, number>,
): readonly number[] => {
  const strippedLines: string[] = [];
  let literalState = NO_OPEN_TEMPLATE;
  let inBlockComment = false;
  for (const raw of content.split("\n")) {
    const { code: lineCode, state } = stripLine(raw, literalState);
    literalState = state;
    const stripped = stripBlockComments(lineCode, inBlockComment);
    inBlockComment = stripped.inBlockComment;
    strippedLines.push(stripped.code);
  }

  const tokens: number[] = [];
  for (const token of strippedLines.join("\n").match(CLONE_TOKEN) ?? []) {
    const cached = cache.get(token);
    if (cached !== undefined) {
      tokens.push(cached);
      continue;
    }
    // Ids start at 1: zero is the value the bounds fallbacks below produce for
    // a position past the end of a file, and no real token may look like that.
    const id = cache.size + 1;
    cache.set(token, id);
    tokens.push(id);
  }
  return tokens;
};

// Consecutive window positions describe one clone region, so a run of them is
// one block. A gap means a second, separate copy in the same file.
const cloneBlockCount = (positions: number[]): number => {
  positions.sort((left, right) => left - right);
  let blocks = 0;
  let previous = -2;
  for (const position of positions) {
    if (position > previous + 1) {
      blocks += 1;
    }
    previous = position;
  }
  return blocks;
};

const countDuplicateTokenBlocks: RepoCounter = (root) => {
  const scanned = scanRepoFiles(root, ALL_SOURCE_GLOBS).filter(
    // A generated file's copies belong to its generator, not to this budget.
    (rel) => !rel.includes("/generated/"),
  );

  // The whole tree's tokens in one flat array, with each file's slice recorded
  // beside it. Keeping them is what lets a candidate match be verified against
  // the sequence it claims to repeat; at four bytes a token the array is far
  // smaller than the sources it came from.
  const tokens: number[] = [];
  const fileStart: number[] = [];
  const fileLength: number[] = [];
  const tokenCache = new Map<string, number>();
  for (const rel of scanned) {
    const full = path.join(root, rel);
    fileStart.push(tokens.length);
    if (statSync(full).size > MAX_CLONE_SCAN_BYTES) {
      fileLength.push(0);
      continue;
    }
    const fileTokens = cloneTokensOf(readFileSync(full, "utf-8"), tokenCache);
    for (const token of fileTokens) {
      tokens.push(token);
    }
    fileLength.push(fileTokens.length);
  }

  const sameSequence = (left: number, right: number): boolean => {
    for (let offset = 0; offset < CLONE_WINDOW_TOKENS; offset += 1) {
      if (tokens[left + offset] !== tokens[right + offset]) {
        return false;
      }
    }
    return true;
  };

  const primaryPower = clonePower(CLONE_BASE_PRIMARY, CLONE_WINDOW_TOKENS - 1);
  const secondaryPower = clonePower(
    CLONE_BASE_SECONDARY,
    CLONE_WINDOW_TOKENS - 1,
  );
  // Primary hash to the head of a chain of occurrences, one per DISTINCT token
  // sequence that hashes there. A sequence that recurs a thousand times still
  // costs one slot; a second sequence colliding on the primary hash gets its
  // own slot instead of being dropped, which is what makes the index total.
  const headSlotOf = new Map<number, number>();
  const slotSecondary: number[] = [];
  const slotFile: number[] = [];
  const slotStart: number[] = [];
  const slotNext: number[] = [];
  const hitPositions = new Map<number, number[]>();

  const recordHit = (fileIndex: number, position: number): void => {
    const positions = hitPositions.get(fileIndex);
    if (positions === undefined) {
      hitPositions.set(fileIndex, [position]);
      return;
    }
    positions.push(position);
  };

  for (const [fileIndex] of scanned.entries()) {
    const length = fileLength[fileIndex] ?? 0;
    if (length < CLONE_WINDOW_TOKENS) {
      continue;
    }
    const start = fileStart[fileIndex] ?? 0;

    let primary = 0;
    let secondary = 0;
    for (let index = 0; index < CLONE_WINDOW_TOKENS; index += 1) {
      const token = tokens[start + index] ?? 0;
      primary = Math.imul(primary, CLONE_BASE_PRIMARY) + token;
      secondary = Math.imul(secondary, CLONE_BASE_SECONDARY) + token;
    }

    const lastPosition = length - CLONE_WINDOW_TOKENS;
    for (let position = 0; position <= lastPosition; position += 1) {
      if (position > 0) {
        const leaving = tokens[start + position - 1] ?? 0;
        const entering =
          tokens[start + position + CLONE_WINDOW_TOKENS - 1] ?? 0;
        primary =
          Math.imul(
            primary - Math.imul(leaving, primaryPower),
            CLONE_BASE_PRIMARY,
          ) + entering;
        secondary =
          Math.imul(
            secondary - Math.imul(leaving, secondaryPower),
            CLONE_BASE_SECONDARY,
          ) + entering;
      }

      const windowStart = start + position;
      let slot = headSlotOf.get(primary) ?? -1;
      let matched = -1;
      while (slot !== -1) {
        if (
          slotSecondary[slot] === secondary &&
          sameSequence(slotStart[slot] ?? 0, windowStart)
        ) {
          matched = slot;
          break;
        }
        slot = slotNext[slot] ?? -1;
      }

      if (matched === -1) {
        slotSecondary.push(secondary);
        slotFile.push(fileIndex);
        slotStart.push(windowStart);
        slotNext.push(headSlotOf.get(primary) ?? -1);
        headSlotOf.set(primary, slotSecondary.length - 1);
        continue;
      }

      const firstFile = slotFile[matched] ?? 0;
      const firstPosition =
        (slotStart[matched] ?? 0) - (fileStart[firstFile] ?? 0);
      // Inside one file, overlapping windows are the same text read twice.
      if (
        firstFile === fileIndex &&
        position - firstPosition < CLONE_WINDOW_TOKENS
      ) {
        continue;
      }
      recordHit(fileIndex, position);
      recordHit(firstFile, firstPosition);
    }
  }

  const files: Record<string, number> = {};
  let count = 0;
  for (const [fileIndex, positions] of hitPositions) {
    const rel =
      scanned[fileIndex] ?? panic("ratchet lost a duplicate-block file index");
    const blocks = cloneBlockCount(positions);
    files[rel] = blocks;
    count += blocks;
  }
  return { count, files };
};

const RATCHET_METRICS: readonly RatchetMetric[] = [
  {
    scope: "file",
    id: "as-casts",
    description:
      "`as` type assertions in app source (excl. `as const`, import aliases, tests/gen/d.ts)",
    include: APP_SOURCE_GLOBS,
    exclude: isExcludedSource,
    count: countAsCasts,
  },
  {
    scope: "file",
    id: "super-linear-regexes",
    description:
      "regex literals with super-linear worst-case backtracking, repo-wide (one oversized input blocks the event loop); at 0 — keep it there",
    include: ALL_SOURCE_GLOBS,
    exclude: isExcludedSource,
    count: countSuperLinearRegexes,
  },
  {
    scope: "file",
    id: "legacy-realtime-invalidation-producers",
    description:
      "legacy invalidate-query event producers and route activations in API source; at 0 — keep it there",
    include: ["apps/api/src/**/*.{ts,tsx}"],
    exclude: isExcludedSource,
    count: countLegacyRealtimeInvalidationProducers,
  },
  {
    scope: "file",
    id: "legacy-manual-mcp-input-schemas",
    description:
      "tools in MCP_LEGACY_MANUAL_INPUT_SCHEMA_TOOL_NAMES whose hand-authored JSON Schema mirrors a separate runtime validator; each Valibot source-of-truth conversion removes one entry",
    include: ["apps/api/src/mcp/static-tool-definitions.ts"],
    exclude: () => false,
    count: countLegacyManualMcpInputSchemas,
  },
  {
    scope: "file",
    id: "nullish-array-fallback",
    description:
      "`?? []` fallbacks in app source (structural invariants should panic() instead)",
    include: APP_SOURCE_GLOBS,
    exclude: isExcludedSource,
    count: countNullishArrayFallback,
  },
  {
    scope: "file",
    id: "barrel-index-files",
    description:
      "index.ts/index.tsx barrel files under apps/{api,web}/src (packages entry points and TanStack route index files excluded)",
    include: [
      "apps/api/src/**/index.{ts,tsx}",
      "apps/web/src/**/index.{ts,tsx}",
    ],
    // TanStack Router index routes (apps/web/src/routes/**/index.tsx) are route
    // files, not barrels — a new index route must not trip the ratchet.
    exclude: (file) =>
      isExcludedSource(file) || file.includes("apps/web/src/routes/"),
    count: countPresence,
  },
  {
    scope: "file",
    id: "direct-error-message-display",
    description:
      "direct display of raw error.message/result.error.message in web source; prefer translated fallbacks and userError helpers",
    include: ["apps/web/src/**/*.{ts,tsx}"],
    exclude: (file) =>
      isExcludedSource(file) ||
      file === "apps/web/src/lib/errors/index.ts" ||
      file.includes("apps/web/src/routes/dev/") ||
      file.startsWith("apps/web/src/workers/"),
    count: countDirectErrorMessageDisplay,
  },
  {
    scope: "file",
    id: "module-level-mutable-collections",
    description:
      "module-scope `new Map(`/`new Set(` assignments in web source (per-thread/entity registries that never evict); WeakMap/WeakSet excluded (GC-safe by construction)",
    include: ["apps/web/src/**/*.{ts,tsx}"],
    exclude: isExcludedSource,
    count: countModuleLevelMutableCollections,
  },
  {
    scope: "file",
    id: "entity-kind-glyph-adhoc",
    description:
      "raw folder/task lucide glyph identifiers (Folder/FolderOpen/ListTodo, with or without the Icon suffix) in web source outside entity-kind-icon.tsx; every entity glyph belongs to <EntityKindIcon> (see no-direct-entity-glyph)",
    include: ["apps/web/src/**/*.{ts,tsx}"],
    exclude: (file) =>
      isExcludedSource(file) ||
      file === "apps/web/src/components/workspaces/entity-kind-icon.tsx",
    count: countEntityKindGlyphs,
  },
  {
    scope: "file",
    id: "hand-rolled-user-identity",
    description:
      "<UserAvatar> JSX openings outside the shared user-avatar component (fuzzy superset; paired avatar+label shapes are banned by no-hand-rolled-user-identity)",
    include: ["apps/web/src/**/*.{ts,tsx}"],
    exclude: (file) =>
      isExcludedSource(file) ||
      file === "apps/web/src/components/user-avatar.tsx",
    count: countHandRolledUserIdentity,
  },
  {
    scope: "file",
    id: "raw-user-avatar-primitive",
    description:
      "imports of @stll/ui/avatar outside the shared owner and explicit non-user exceptions",
    include: ["apps/web/src/**/*.{ts,tsx}"],
    exclude: (file) =>
      isExcludedSource(file) ||
      [
        "apps/web/src/components/public-workspace-shell.tsx",
        "apps/web/src/routes/auth/organization.tsx",
        "apps/web/src/routes/dev/-components/ui-playground.tsx",
        "apps/web/src/components/ai-suggestions/review-panel.impl.tsx",
      ].includes(file),
    count: countRawUserAvatarPrimitive,
  },
  {
    scope: "file",
    id: "shadowed-user-name-helpers",
    description:
      "module-like const/function declarations named getDisplayName or getInitials outside apps/web/src/lib",
    include: ["apps/web/src/**/*.{ts,tsx}"],
    exclude: (file) =>
      isExcludedSource(file) || file.includes("apps/web/src/lib/"),
    count: countShadowedUserNameHelpers,
  },
  {
    scope: "file",
    id: "ad-hoc-relative-time-formatting",
    description:
      "native title={formatFullTimestamp(...)} plus date-and-time locale option objects outside the canonical formatter",
    include: ["apps/web/src/**/*.{ts,tsx}"],
    exclude: (file) =>
      isExcludedSource(file) || file === "apps/web/src/lib/relative-time.ts",
    count: countAdHocRelativeTimeFormatting,
  },
  {
    scope: "file",
    id: "direct-audit-log-insert",
    description:
      "direct .insert(auditLogs) calls outside the audit-log recorder module",
    include: ["apps/api/src/**/*.{ts,tsx}"],
    exclude: (file) =>
      isExcludedSource(file) || file === "apps/api/src/lib/audit-log.ts",
    count: countDirectAuditLogInserts,
  },
  {
    scope: "file",
    id: "inline-timestamp-cursor-sql",
    description:
      "Z-less PostgreSQL microsecond cursor formats and inline UTC timestamp re-anchors outside db-pagination and non-cursor date arithmetic",
    include: ["apps/api/src/**/*.{ts,tsx}"],
    exclude: (file) =>
      isExcludedSource(file) ||
      file === "apps/api/src/lib/db-pagination.ts" ||
      file === "apps/api/src/handlers/case-law/citation-authority.ts",
    count: countInlineTimestampCursorSql,
  },
  {
    scope: "file",
    id: "repeated-timestamp-cursor-boundary",
    description:
      "pgTimestampCursorBoundary calls beyond the first per API source file (fuzzy proxy for hand-built timestamp/id disjunctions; explicit heterogeneous/range owners excluded)",
    include: ["apps/api/src/**/*.{ts,tsx}"],
    exclude: (file) =>
      isExcludedSource(file) ||
      file === "apps/api/src/lib/db-pagination.ts" ||
      file === "apps/api/src/lib/entities/list-cursor.ts" ||
      file === "apps/api/src/lib/workflow-target-queries.ts",
    count: countRepeatedTimestampCursorBoundaries,
  },
  {
    scope: "file",
    id: "throw-outside-boundary",
    description:
      "non-identifier `throw` statements outside the `better-result` boundary (RESULT_BOUNDARY_GLOBS), excl. `throw panic(...)`; Oxlint owns precise enforcement for changed files",
    include: RESULT_CONVENTION_SOURCE_GLOBS,
    exclude: isExcludedFromResultConventionMetrics,
    count: countThrowsOutsideBoundary,
  },
  {
    scope: "file",
    id: "try-catch-outside-boundary",
    description:
      "`catch` clauses outside the `better-result` boundary (RESULT_BOUNDARY_GLOBS); excludes Result.tryPromise's `catch:` object key",
    include: RESULT_CONVENTION_SOURCE_GLOBS,
    exclude: isExcludedFromResultConventionMetrics,
    count: countTryCatchOutsideBoundary,
  },
  ...PER_RULE_SUPPRESSION_METRICS,
  {
    scope: "file",
    id: "lint-suppression-directives",
    description:
      "eslint-/oxlint-disable directives naming only rules with no dedicated budget, repo-wide (residual suppression pressure; the per-rule budgets above are subtracted, so no rule's burn-down can fund another rule's new waiver). Same scope as those budgets, so every directive in the tree is charged to exactly one of them",
    include: ALL_SOURCE_GLOBS,
    exclude: isExcludedSource,
    count: countResidualLintSuppressions,
  },
  {
    scope: "file",
    id: "ts-suppression-directives",
    description:
      "@ts-expect-error/@ts-ignore/@ts-nocheck directives in app source (each hides a type error from the compiler)",
    include: APP_SOURCE_GLOBS,
    exclude: isExcludedSource,
    count: countTsSuppressions,
  },
  {
    scope: "file",
    id: "detached-promise-review-sites",
    description:
      "detached-work syntax requiring rejection review: `void` calls without a same-line `.catch(...)`, plus direct async JSX callbacks (lexical; not every site is a Promise or bug)",
    include: APP_SOURCE_GLOBS,
    exclude: isExcludedSource,
    count: countUnhandledDetachedPromises,
  },
  {
    scope: "file",
    id: "cross-handler-imports",
    description:
      "imports crossing API handler domains (handlers/<a> -> handlers/<b>/...); handler domains are vertical slices — shared code belongs in apps/api/src/lib",
    include: ["apps/api/src/handlers/**/*.ts"],
    exclude: isExcludedSource,
    count: countCrossSliceImports(crossesHandlerDomain),
  },
  {
    scope: "file",
    id: "ad-hoc-decision-subject-gates",
    description:
      "direct `isRedistributable(` calls in public case-law decision/provision handlers. The subject gate lives in `decisions/public-subject.ts` and reaches handlers as a branded subject; a handler re-checking it by hand is the pattern that let two endpoints ship ungated. Stays at 0",
    include: [
      "apps/api/src/handlers/case-law/decisions/**/*.ts",
      "apps/api/src/handlers/case-law/provisions/**/*.ts",
    ],
    exclude: (file) =>
      isExcludedSource(file) || file.endsWith("/decisions/public-subject.ts"),
    count: countDirectRedistributableCalls,
  },
  {
    scope: "file",
    id: "lib-to-handler-imports",
    description:
      "imports from shared API lib code into handler slices; dependency direction must flow from handlers to lib",
    include: ["apps/api/src/lib/**/*.ts"],
    exclude: isExcludedSource,
    count: countCrossSliceImports(crossesLibToHandler),
  },
  {
    scope: "file",
    id: "cross-route-private-imports",
    description:
      "imports reaching into another top-level route dir's `-`-private paths (TanStack route slices); move shared code to components/, lib/, or a feature dir",
    include: ["apps/web/src/**/*.{ts,tsx}"],
    exclude: isExcludedSource,
    count: countCrossSliceImports(crossesRoutePrivate),
  },
  {
    scope: "file",
    id: "capability-schemas-truncated",
    description:
      "capabilities carrying `inputSchemaTruncated`, the flag that used to mark a schema dropped for size. The exporter now $defs-compacts schemas and FAILS on one still over the byte cap, so this can only be reached by reintroducing the truncation pathway: it stays at 0",
    include: ["packages/cli/capability-catalog.json"],
    // Generated artifacts are the subject here, so the shared source
    // exclusions (which skip `.gen.`/generated paths) must not apply.
    exclude: () => false,
    count: countTruncatedCapabilitySchemas,
  },
  {
    scope: "file",
    id: "capability-file-transport-suppressed",
    description:
      "capabilities whose transport disposition suppresses them from the generic transport (a file response, or a REQUIRED file input): dropped from the CLI tree and refused by invoke_capability, so no agent surface can reach them. An OPTIONAL file input is not counted — its JSON modes stay invokable",
    include: ["packages/cli/capability-catalog.json"],
    // Generated artifacts are the subject here, so the shared source
    // exclusions (which skip `.gen.`/generated paths) must not apply.
    exclude: () => false,
    count: countFileTransportSuppressed,
  },
  {
    scope: "file",
    id: "read-capabilities-with-write-scope",
    description:
      "read capabilities whose required scope is a write-only grant (admin/billing/documents/knowledge/matters _write), unreachable by a read-only credential; the exporter's access-keyed scope resolver keeps this at 0",
    include: ["packages/cli/capability-catalog.json"],
    // Generated artifacts are the subject here, so the shared source
    // exclusions (which skip `.gen.`/generated paths) must not apply.
    exclude: () => false,
    count: countReadCapabilitiesWithWriteScope,
  },
  {
    scope: "file",
    id: "capability-domain-action-verbs",
    description:
      "reviewed non-canonical capability action verbs (DOMAIN_ACTION_VERBS); each is a public command verb outside list/get/create/update/delete",
    include: ["apps/api/scripts/lib/capability-catalog.ts"],
    exclude: () => false,
    count: countDomainActionVerbs,
  },
  {
    scope: "file",
    id: "cli-shadowed-namespaces",
    description:
      "namespaces where a curated command and a generated capability command share a top-level name, so callers cannot tell which mechanism they get",
    include: ["packages/cli/src/generate-capability-tree.test.ts"],
    exclude: () => false,
    count: countShadowedNamespaces,
  },
  {
    scope: "file",
    id: "cross-feature-imports",
    description:
      "imports crossing web feature slices (features/<a> -> features/<b>); features are independent end-to-end slices",
    include: ["apps/web/src/features/**/*.{ts,tsx}"],
    exclude: isExcludedSource,
    count: countCrossSliceImports(crossesFeature),
  },
  {
    scope: "file",
    id: "workspace-only-rls-on-org-tables",
    description:
      "drizzle tables declaring an organizationId column while authorizing rows with wsPolicies() (workspace pin only) instead of wsOrganizationPolicies(<table>) (workspace pin AND organization pin); at 0 — keep it there",
    include: ["apps/api/src/db/schema/**/*.ts"],
    exclude: isExcludedSource,
    count: countWorkspaceOnlyRlsOnOrgTables,
  },
  {
    scope: "file",
    id: "internal-module-mock-ledger-entries",
    description:
      "grandfathered mock.module targets of workspace modules, one per <test file>::<module> pair in scripts/internal-module-mock-ledger.json (each replaces a real dependency with a fabrication the mocked module's contract changes cannot fail)",
    include: [INTERNAL_MODULE_MOCK_LEDGER_REL],
    exclude: () => false,
    count: countInternalModuleMockLedgerEntries,
  },
  {
    scope: "repo",
    id: "cross-app-lib-path-copies",
    description:
      'files under apps/*/src/lib whose path below src/lib also exists under another app\'s src/lib, both sides counted (the same helper living in two apps; a convention name such as types.ts under two different domain directories is not a copy). The fix is a package — `bun run new-package <name> --description "…"` and import it from both — never a copy',
    count: countCrossAppLibPathCopies,
  },
  {
    scope: "repo",
    id: "cross-workspace-duplicate-export-names",
    description:
      "top-level exported binding names defined in two or more workspaces under apps/*/src/lib and packages/*/src, charged once per extra workspace (names under 4 characters, default exports and generated/ directories excluded); one workspace should own the name and the others import it, via `bun run new-package` when neither owns it yet",
    count: countCrossWorkspaceDuplicateExportNames,
  },
  {
    scope: "repo",
    id: "duplicate-token-blocks",
    description:
      'blocks of 60+ consecutive tokens (comments and literal contents blanked) whose exact token sequence also appears in another file, or at a non-overlapping position in the same one, counted once per block per file with both copies charged. Hand-written TypeScript only (Rust under apps/desktop/src-tauri and Astro under apps/landing/src are outside this scan), excluding tests, generated/ and .gen. files and anything over 300 KB. The fix is to extract the block into whichever module already owns the concern, or into a package (`bun run new-package <name> --description "…"`) when neither side owns it — never to leave both copies in place',
    count: countDuplicateTokenBlocks,
  },
  {
    scope: "repo",
    id: "api-lib-top-level-entries",
    description:
      "direct children of apps/api/src/lib, files and directories alike (tests and __fixtures__ excluded); the flat bucket only shrinks — new code goes into a domain directory or a package",
    count: countLibTopLevelEntries(API_LIB_DIR),
  },
  {
    scope: "repo",
    id: "web-lib-top-level-entries",
    description:
      "direct children of apps/web/src/lib, files and directories alike (tests and __fixtures__ excluded); the flat bucket only shrinks — new code goes into a domain directory or a package",
    count: countLibTopLevelEntries(WEB_LIB_DIR),
  },
];

// --- Scanning ---------------------------------------------------------------

type MetricSnapshot = { count: number; files: Record<string, number> };
type Baseline = Record<string, MetricSnapshot>;

type ConfigurationInspection =
  | { status: "valid"; baseline: Baseline }
  | { status: "invalid"; errors: readonly string[] };

const METRIC_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const ownValue = (record: Record<string, unknown>, key: string): unknown =>
  Object.getOwnPropertyDescriptor(record, key)?.value;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const inspectMetricRegistry = (
  metrics: readonly Pick<RatchetMetric, "id">[],
) => {
  const errors: string[] = [];
  const metricIds = new Set<string>();

  for (const { id } of metrics) {
    if (!METRIC_ID.test(id)) {
      errors.push(`ratchet metric id ${JSON.stringify(id)} is not kebab-case`);
    }
    if (metricIds.has(id)) {
      errors.push(`ratchet metric id ${JSON.stringify(id)} is duplicated`);
    }
    metricIds.add(id);
  }

  return { errors, metricIds };
};

// The metric table and its committed baseline are one mirrored declaration.
// Validate both directions: otherwise deleting a metric leaves an ignored
// baseline entry, while duplicate IDs silently overwrite one scan with another.
// Snapshot totals are derived from their per-file map, so a hand-edited or
// partially resolved baseline cannot weaken the ratchet or its diagnostics.
const inspectConfiguration = (
  metrics: readonly Pick<RatchetMetric, "id">[],
  rawBaseline: unknown,
): ConfigurationInspection => {
  const { errors, metricIds } = inspectMetricRegistry(metrics);

  if (!isRecord(rawBaseline)) {
    return {
      status: "invalid",
      errors: [...errors, "ratchet baseline must be a JSON object"],
    };
  }

  for (const id of metricIds) {
    if (!Object.hasOwn(rawBaseline, id)) {
      errors.push(
        `ratchet metric ${JSON.stringify(id)} is missing from baseline`,
      );
    }
  }
  for (const id of Object.keys(rawBaseline)) {
    if (!metricIds.has(id)) {
      errors.push(
        `ratchet baseline metric ${JSON.stringify(id)} is not registered`,
      );
    }
  }

  const baseline: Baseline = {};
  for (const id of metricIds) {
    const rawSnapshot = ownValue(rawBaseline, id);
    if (!isRecord(rawSnapshot)) {
      if (rawSnapshot !== undefined) {
        errors.push(
          `ratchet baseline metric ${JSON.stringify(id)} must be an object`,
        );
      }
      continue;
    }

    const count = ownValue(rawSnapshot, "count");
    const rawFiles = ownValue(rawSnapshot, "files");
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      errors.push(
        `ratchet baseline metric ${JSON.stringify(id)} count must be a non-negative safe integer`,
      );
      continue;
    }
    if (!isRecord(rawFiles)) {
      errors.push(
        `ratchet baseline metric ${JSON.stringify(id)} files must be an object`,
      );
      continue;
    }

    const files: Record<string, number> = {};
    let fileTotal = 0;
    let filesValid = true;
    for (const [file, value] of Object.entries(rawFiles)) {
      if (
        file.length === 0 ||
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value <= 0
      ) {
        filesValid = false;
        errors.push(
          `ratchet baseline metric ${JSON.stringify(id)} has an invalid count for ${JSON.stringify(file)}`,
        );
        continue;
      }
      files[file] = value;
      fileTotal += value;
    }
    if (!filesValid) {
      continue;
    }
    if (fileTotal !== count) {
      errors.push(
        `ratchet baseline metric ${JSON.stringify(id)} count ${count} does not equal its per-file total ${fileTotal}`,
      );
      continue;
    }
    baseline[id] = { count, files };
  }

  return errors.length === 0
    ? { status: "valid", baseline }
    : { status: "invalid", errors };
};

const assertMetricRegistry = (): void => {
  const { errors } = inspectMetricRegistry(RATCHET_METRICS);
  if (errors.length > 0) {
    panic(errors.join("\n"));
  }
};

const requireSnapshot = (baseline: Baseline, id: string): MetricSnapshot =>
  baseline[id] ?? panic(`ratchet metric ${id} is missing from the snapshot`);

const sortedSnapshot = (result: RepoMetricResult): MetricSnapshot => {
  const files: Record<string, number> = {};
  for (const rel of Object.keys(result.files).sort()) {
    files[rel] =
      result.files[rel] ??
      panic(`ratchet count for ${rel} disappeared during scan`);
  }
  return { count: result.count, files };
};

const scanMetric = (metric: RatchetMetric, root: string): MetricSnapshot => {
  switch (metric.scope) {
    case "repo":
      return sortedSnapshot(metric.count(root));
    case "file": {
      const seen = new Set<string>();
      const files: Record<string, number> = {};
      let count = 0;

      for (const glob of metric.include) {
        for (const rel of new Bun.Glob(glob).scanSync(root)) {
          if (seen.has(rel)) {
            continue;
          }
          seen.add(rel);
          if (metric.exclude(rel)) {
            continue;
          }
          const n = metric.count(
            readFileSync(path.join(root, rel), "utf-8"),
            rel,
          );
          if (n > 0) {
            files[rel] = n;
            count += n;
          }
        }
      }

      return sortedSnapshot({ count, files });
    }
    default: {
      const unreachable: never = metric;
      return panic(
        `ratchet metric has an unknown scope: ${String(unreachable)}`,
      );
    }
  }
};

const scanAll = (root: string): Baseline => {
  assertMetricRegistry();
  const snapshot: Baseline = {};
  for (const metric of RATCHET_METRICS) {
    snapshot[metric.id] = scanMetric(metric, root);
  }
  return snapshot;
};

const readBaseline = (): Baseline => {
  const parsed = Result.try((): unknown =>
    JSON.parse(readFileSync(BASELINE_PATH, "utf-8")),
  );
  if (Result.isError(parsed)) {
    panic(`ratchet baseline ${BASELINE_REL} is not valid JSON`);
  }
  const inspection = inspectConfiguration(RATCHET_METRICS, parsed.value);
  if (inspection.status === "invalid") {
    panic(inspection.errors.join("\n"));
  }
  return inspection.baseline;
};

const writeBaseline = (snapshot: Baseline): void => {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
};

// --- Diffing ----------------------------------------------------------------

type MetricStatus = "ok" | "regressed" | "dropped";

type RegressedFile = { file: string; from: number; to: number };

type MetricDiff = {
  id: string;
  status: MetricStatus;
  current: number;
  baseline: number;
  regressedFiles: RegressedFile[];
};

const metricStatus = (current: number, baseline: number): MetricStatus => {
  if (current > baseline) {
    return "regressed";
  }
  if (current < baseline) {
    return "dropped";
  }
  return "ok";
};

const diffMetric = (
  id: string,
  current: MetricSnapshot,
  baseline: MetricSnapshot,
): MetricDiff => {
  const regressedFiles: RegressedFile[] = [];
  for (const [file, to] of Object.entries(current.files)) {
    const from = baseline.files[file] ?? 0;
    if (to > from) {
      regressedFiles.push({ file, from, to });
    }
  }
  regressedFiles.sort((a, b) => a.file.localeCompare(b.file));

  const status = metricStatus(current.count, baseline.count);

  return {
    id,
    status,
    current: current.count,
    baseline: baseline.count,
    regressedFiles,
  };
};

// --- Modes ------------------------------------------------------------------

const formatDelta = (delta: number): string => {
  if (delta > 0) {
    return `+${delta}`;
  }
  if (delta < 0) {
    return `${delta}`;
  }
  return "0";
};

const runReport = (): number => {
  const current = scanAll(REPO_ROOT);
  const baseline = readBaseline();
  const showDetails = process.argv.includes("--details");
  console.log("ratchet: current metric counts (vs baseline)\n");
  for (const metric of RATCHET_METRICS) {
    const c = requireSnapshot(current, metric.id);
    const b = baseline[metric.id]?.count ?? 0;
    const delta = c.count - b;
    const sign = formatDelta(delta);
    console.log(
      `  ${metric.id.padEnd(30)} ${String(c.count).padStart(5)}  (baseline ${b}, ${sign})`,
    );
    console.log(`  ${" ".repeat(30)} ${metric.description}`);
    if (showDetails) {
      for (const [file, count] of Object.entries(c.files)) {
        console.log(`  ${" ".repeat(30)} ${count}  ${file}`);
      }
    }
  }
  return 0;
};

const runWrite = (): number => {
  const snapshot = scanAll(REPO_ROOT);
  writeBaseline(snapshot);
  console.log(`Wrote ratchet baseline to ${BASELINE_REL}:`);
  for (const metric of RATCHET_METRICS) {
    const snap = requireSnapshot(snapshot, metric.id);
    console.log(
      `  ${metric.id.padEnd(30)} ${String(snap.count).padStart(5)} across ${Object.keys(snap.files).length} file(s)`,
    );
  }
  return 0;
};

const runCheck = (): number => {
  const current = scanAll(REPO_ROOT);
  const baseline = readBaseline();

  const regressions: MetricDiff[] = [];
  const drops: MetricDiff[] = [];

  for (const metric of RATCHET_METRICS) {
    const base = baseline[metric.id] ?? { count: 0, files: {} };
    const diff = diffMetric(
      metric.id,
      requireSnapshot(current, metric.id),
      base,
    );
    if (diff.status === "regressed") {
      regressions.push(diff);
    }
    if (diff.status === "dropped") {
      drops.push(diff);
    }
  }

  for (const diff of drops) {
    console.log(
      `ratchet: ${diff.id} dropped ${diff.baseline} -> ${diff.current}. Nice — run \`${WRITE_HINT}\` and commit ${BASELINE_REL} to lock it in.`,
    );
  }

  if (regressions.length === 0) {
    console.log(
      `ratchet --check: OK. ${RATCHET_METRICS.length} metric(s) at or below baseline.`,
    );
    return 0;
  }

  console.error("\nratchet --check: metric(s) rose above baseline:\n");
  for (const diff of regressions) {
    console.error(
      `  ${diff.id}: ${diff.baseline} -> ${diff.current} (+${diff.current - diff.baseline})`,
    );
    for (const { file, from, to } of diff.regressedFiles) {
      console.error(`      ${file}: ${from} -> ${to}`);
    }
  }
  console.error(
    "\nThese metrics may only decrease. Remove the new occurrence(s) above, or,\n" +
      `if the increase is genuinely justified, run \`${WRITE_HINT}\` and commit\n` +
      `${BASELINE_REL} with a rationale in your PR.`,
  );
  return 1;
};

// --- Self-test --------------------------------------------------------------
// Materialize synthetic fixtures under a temp repo root, run the real metric
// globs + counters over them, and assert exact counts. Also exercise the diff
// so a rise fails and an equal count passes.

// Lines are authored as an array (one line, one string) so quote characters
// inside the fixture never have to fight the outer template literal's own
// escaping rules.
const AS_CAST_FIXTURE_LINES = [
  'import { foo as bar } from "./x";',
  'export * as ns from "./y";',
  "import {",
  "  wide as narrow,",
  "  other as thing,",
  '} from "./multi";',
  "const a = value as Widget;",
  "const b = value as const;",
  "const c = value as unknown as Widget;",
  "// prose that says as much as it can",
  "const d = (value as readonly string[]).length; // trailing as comment",
  'const label1 = "stored as json"; // double-quoted string must not count',
  "const label2 = 'stored as json'; // single-quoted string must not count",
  "const label3 = `stored as json`; // template-literal string must not count",
  'const escaped = "a \\" as \\" b"; // escaped quote must not end the string early',
  'const real = (value as string) + "not as this" + (other as number);',
  'const url = ("http://example.com" as string).length; // "//" in a string must not eat the rest of the line',
  "const tmpl = `first line: as if it mattered",
  "second line: also as filler",
  "end` as Widget;",
  `type Remapped<T> = { [K in keyof T as \`get\${K & string}\`]: T[K] };`,
];
const SELF_TEST_AS_CASTS = `${AS_CAST_FIXTURE_LINES.join("\n")}\n`;
// Expected as-casts: `a`(1), `c` collapsed(1), `d`(1), `real`'s two casts(2),
// `url`'s cast(1), the cast right after the multi-line template closes(1) = 7.
// The single-line alias imports, the MULTI-LINE import block (its
// `wide as narrow` / `other as thing` continuation lines), `as const`, the
// pure-comment line, all three string-literal false positives (double/single/
// template quoted), the escaped-quote string, the "as" text inside the
// multi-line template body, and the "//" inside the url string are all
// excluded.
const EXPECTED_AS_CASTS = 7;

const SUPER_LINEAR_REGEX_FIXTURE_LINES = [
  // Counted: the shape that stalled the ingestion worker — the leading
  // token run makes every start offset re-walk the rest of the input.
  String.raw`const judge = /(?<judge>\S+(?:\s+\S+){0,2})\s+\(soudce\)/iu;`,
  // Counted: `[\d\s]*` overlaps the `\s+` that follows it.
  String.raw`const count = /(?<count>\d[\d\s]*)\s+výsledk/iu;`,
  // Counted: two of them on one line.
  String.raw`const pair = [/^[A-Z]\s+[A-Z\s]+$/u, /(?:a+)+b/u];`,
  // Counted: quotes inside the pattern must not hide it. A line-based
  // scanner blanks from the first `"` and never sees the rest.
  String.raw`const attr = /\s*scale="[^"]*"/u;`,
  String.raw`const apos = /\s*name='[^']*'/u;`,
  // Not counted: linear, anchored on a literal.
  String.raw`const safe = /Id="rId(?<num>\d+)"/gu;`,
  // Not counted: linear alternation of literals.
  String.raw`const alt = /^(?:alpha|beta|gamma)$/u;`,
  // Not counted: a comment.
  String.raw`// const commented = /(?:a+)+b/u;`,
  // Not counted: inside string and template literals.
  String.raw`const inString = "/(?:a+)+b/u";`,
  "const inTemplate = `/(?:a+)+b/u`;",
  // Not counted: division, not a regex literal.
  String.raw`const ratio = (total) / (count + 1) / 2;`,
];
const SELF_TEST_SUPER_LINEAR_REGEXES = `${SUPER_LINEAR_REGEX_FIXTURE_LINES.join("\n")}\n`;
// Expected: judge(1) + count(1) + the two on the `pair` line(2) + the two
// quote-bearing patterns(2) = 6. The anchored/alternation patterns, the
// comment, the string and template literals, and the division expression are
// all excluded. The quote-bearing pair is the regression guard for the
// line-scanner blind spot this counter was rewritten to close.
const EXPECTED_SUPER_LINEAR_REGEXES = 6;

const NULLISH_FIXTURE_LINES = [
  "const a = list ?? [];",
  "const b = other ??[];",
  "const c = map ?? {};",
  "// fallback ?? [] in a comment must not count",
  "const d = both ?? [] ?? [];",
  'const e = "danger ?? [] in a string"; // string must not count',
  "const f = 'danger ?? [] in a string'; // string must not count",
  "const g = `danger ?? [] in a string`; // template string must not count",
  'const h = (list ?? []) + "not ?? [] in this string";',
];
const SELF_TEST_NULLISH = `${NULLISH_FIXTURE_LINES.join("\n")}\n`;
// Expected: a(1) + b(1) + d(2) + h(1) = 5; `?? {}`, the comment, and the
// string/template false positives (e, f, g) are excluded.
const EXPECTED_NULLISH = 5;

const LEGACY_REALTIME_INVALIDATION_FIXTURE_LINES = [
  'const direct = { type: "invalidate-query", data: ["entities"] };',
  "const named = { type: REALTIME_EVENT_TYPE.INVALIDATE_QUERY, data: key };",
  "const workspaceRoute = { invalidateQuery: true };",
  "const organizationRoute = { invalidateOrganizationQuery: true };",
  "broadcastQueryInvalidationToOrganization(organizationId, key);",
  "broadcastQueryInvalidationToTargetWorkspace(workspaceId, key);",
  'broadcastInvalidation(workspaceId, ["entities", workspaceId]);',
  "const disabled = { invalidateQuery: false };",
  "// const ignored = { invalidateQuery: true };",
];
const SELF_TEST_LEGACY_REALTIME_INVALIDATIONS = `${LEGACY_REALTIME_INVALIDATION_FIXTURE_LINES.join("\n")}\n`;
const EXPECTED_LEGACY_REALTIME_INVALIDATIONS = 7;

const LEGACY_MANUAL_MCP_INPUT_SCHEMA_FIXTURE_LINES = [
  "const MCP_LEGACY_MANUAL_INPUT_SCHEMA_TOOL_NAMES = [",
  '  "search",',
  '  "fetch",',
  '  "list_matters",',
  "] as const satisfies readonly LegacyManualInputToolName[];",
  'const unrelated = ["save_template"];',
  '// "commented_tool",',
];
const SELF_TEST_LEGACY_MANUAL_MCP_INPUT_SCHEMAS = `${LEGACY_MANUAL_MCP_INPUT_SCHEMA_FIXTURE_LINES.join("\n")}\n`;
const EXPECTED_LEGACY_MANUAL_MCP_INPUT_SCHEMAS = 3;

const ENTITY_GLYPH_FIXTURE_LINES = [
  'import { FolderIcon, FolderOpenIcon, ListTodoIcon } from "lucide-react";',
  "const shut = <FolderIcon />;",
  "const open = <FolderOpenIcon />;",
  "const todo = <ListTodoIcon />;",
  "const plain = <Folder />;",
  "const nested = folderIcon.FolderIcon;",
  "const unrelated = <FolderTreeIcon />; // longer identifier must not count",
  "const lower = folder.entityId; // lowercase property must not count",
  'const label = "FolderIcon in a string"; // string must not count',
  "// FolderIcon in a comment must not count",
];
const SELF_TEST_ENTITY_GLYPHS = `${ENTITY_GLYPH_FIXTURE_LINES.join("\n")}\n`;
// Expected: the three import specifiers(3) + shut(1) + open(1) + todo(1) +
// plain(1) + the nested member access(1) = 8. `FolderTreeIcon` (a different
// identifier), the lowercase property, the string literal and the comment
// are all excluded.
const EXPECTED_ENTITY_GLYPHS = 8;

const SHARED_WEB_HELPER_FIXTURE_LINES = [
  'import { Avatar } from "@stll/ui/avatar";',
  'import { UserIdentity } from "@/components/user-avatar";',
  'import { formatFullTimestamp as fullTimestamp } from "@/lib/relative-time";',
  "const avatar = <UserAvatar name={user.name} />;",
  "const identity = <UserIdentity name={user.name} />;",
  "const getDisplayName = (name: string) => name;",
  "function getInitials(name: string) { return name.slice(0, 2); }",
  "const formatDisplayName = (name: string) => name;",
  'const full = value.toLocaleString(locale, { dateStyle: "full", timeStyle: "medium" });',
  "const native = <span title={formatFullTimestamp(value)} />;",
  "const aliasedNative = <span title={fullTimestamp(value)} />;",
  'const dateOnly = value.toLocaleString(locale, { dateStyle: "full" });',
  'const timeOnly = value.toLocaleString(locale, { timeStyle: "medium" });',
  "const quotePattern = /[\"']/u;",
  "const urlPattern = /https:\\/\\//u;",
  "// <UserAvatar /> and const getInitials = () => '?' must not count.",
  '// import { Avatar } from "@stll/ui/avatar";',
  "// title={formatFullTimestamp(value)} must not count.",
];
const SELF_TEST_SHARED_WEB_HELPERS = `${SHARED_WEB_HELPER_FIXTURE_LINES.join("\n")}\n`;
const EXPECTED_HAND_ROLLED_USER_IDENTITIES = 1;
const EXPECTED_RAW_USER_AVATAR_PRIMITIVES = 1;
const EXPECTED_SHADOWED_USER_NAME_HELPERS = 2;
const EXPECTED_AD_HOC_RELATIVE_TIME_FORMATTING = 3;

const SHARED_API_HELPER_FIXTURE_LINES = [
  "await tx.insert(auditLogs).values(rows);",
  "await tx.insert(otherLogs).values(rows);",
  "const naive = sql`to_char(createdAt, 'YYYY-MM-DD\"T\"HH24:MI:SS.US')`;",
  'const canonical = sql`to_char(createdAt, \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\')`;',
  [
    "const boundary = sql`(",
    "$",
    "{value}::timestamp AT TIME ZONE 'UTC')`;",
  ].join(""),
  "// tx.insert(auditLogs) must not count.",
  '// YYYY-MM-DD"T"HH24:MI:SS.US must not count.',
  "// value::timestamp AT TIME ZONE 'UTC' must not count.",
];
const SELF_TEST_SHARED_API_HELPERS = `${SHARED_API_HELPER_FIXTURE_LINES.join("\n")}\n`;
const EXPECTED_DIRECT_AUDIT_LOG_INSERTS = 1;
const EXPECTED_INLINE_TIMESTAMP_CURSOR_SQL = 2;

const TIMESTAMP_BOUNDARY_FIXTURE_LINES = [
  'import { or as anyOf } from "drizzle-orm";',
  'import { pgTimestampCursorBoundary as cursorBoundary } from "@/api/lib/db-pagination";',
  [
    "const manual = or(",
    "lt(column, pgTimestampCursorBoundary(first)), ",
    "eq(column, pgTimestampCursorBoundary(first))",
    ");",
  ].join(""),
  [
    "const aliased = anyOf(",
    "lt(column, cursorBoundary(second)), ",
    "eq(column, cursorBoundary(second))",
    ");",
  ].join(""),
  "const first = pgTimestampCursorBoundary(cursor.timestamp);",
  "const second = pgTimestampCursorBoundary(other.timestamp);",
  "const unrelated = buildTimestampBoundary(value);",
  "// or(pgTimestampCursorBoundary(a), pgTimestampCursorBoundary(b))",
];
const SELF_TEST_TIMESTAMP_BOUNDARIES = `${TIMESTAMP_BOUNDARY_FIXTURE_LINES.join("\n")}\n`;
const EXPECTED_REPEATED_TIMESTAMP_CURSOR_BOUNDARIES = 2;

const DIRECT_ERROR_FIXTURE_LINES = [
  "stellaToast.add({ title: error instanceof Error ? error.message : fallback });",
  "stellaToast.add({ title: error.message ?? fallback });",
  "stellaToast.add({ title: result.error.message ?? fallback });",
  "if (APIError.is(error) &&",
  "    error.message) {",
  "const internal = userErrorMessage(response.error, fallback);",
  'const literal = "error.message ?? fallback";',
  "// error instanceof Error ? error.message : fallback",
];
const SELF_TEST_DIRECT_ERROR = `${DIRECT_ERROR_FIXTURE_LINES.join("\n")}\n`;
// Expected: four direct user-facing-ish raw-message displays; helper use,
// string literal, and comment are excluded.
const EXPECTED_DIRECT_ERROR = 4;

const MODULE_COLLECTION_FIXTURE_LINES = [
  "const frozenSet = new Set([1, 2, 3]);",
  "export const exportedRegistry = new Map<string, number>();",
  "let mutableCounter = new Set<string>();",
  'const readonlyTyped: ReadonlySet<string> = new Set(["a"]);',
  "const readonlyMapTyped: ReadonlyMap<string, number> = new Map();",
  "const typed: Set<string> = new Set();",
  "const withArrowType: Map<string, () => void> = new Map();",
  "const multiline = new Map<",
  "  string,",
  "  number",
  ">();",
  "const weakOk = new WeakMap<object, number>();",
  "const weakSetOk = new WeakSet<object>();",
  "function useLocalCache() {",
  "  const indented = new Map<string, number>();",
  "  return indented;",
  "}",
  "// const commentedOut = new Map();",
];
const SELF_TEST_MODULE_COLLECTIONS = `${MODULE_COLLECTION_FIXTURE_LINES.join("\n")}\n`;
// Expected: frozenSet(1) + exportedRegistry(1) + mutableCounter(1) + typed(1)
// + withArrowType(1) + multiline(1, counted on its opening line even though
// `new Map<` spans to a later `>()`) = 6. The `ReadonlySet`/`ReadonlyMap`
// typed bindings, WeakMap/WeakSet, the indented (function-scoped)
// declaration, and the commented-out line are all excluded.
const EXPECTED_MODULE_COLLECTIONS = 6;

const LINT_SUPPRESSION_FIXTURE_LINES = [
  "// eslint-disable-next-line no-console -- reason one",
  "// oxlint-disable-next-line some-plugin/some-rule -- reason two",
  "/* eslint-disable no-console */",
  "// oxlint-disable",
  'const doc = "// eslint-disable-next-line fake"; // directive in a string must not count',
  "/* example: // eslint-disable-next-line fake */",
  "/* example across lines:",
  "// oxlint-disable-next-line fake",
  "*/",
  "// eslint disables discussed in prose (no hyphenated directive) must not count",
];
const SELF_TEST_LINT_SUPPRESSIONS = `${LINT_SUPPRESSION_FIXTURE_LINES.join("\n")}\n`;
// The residual budget takes only directives that name at least one rule and
// no tracked rule. From THIS fixture: both linters' -next-line forms and the
// block-comment form = 3. The bare `oxlint-disable` is excluded because it
// silences every tracked rule and is charged to each of their budgets
// instead; the string copy, the ordinary block-comment examples, and the
// prose comment are not directives at all.
const EXPECTED_LINT_SUPPRESSIONS_OWN_FILE = 3;
// Repo-wide residual: 3 here, 1 in the raw-use-effect fixture (its two
// no-raw-use-effect directives are tracked, its exhaustive-deps one is not),
// and 3 in the query-limit fixture (its no-console-only directives). Every
// directive naming a tracked rule is absent — that absence IS the partition.
const EXPECTED_LINT_SUPPRESSIONS_TOTAL = 7;

const REQUIRE_QUERY_LIMIT_SUPPRESSION_FIXTURE_LINES = [
  "// eslint-disable-next-line require-query-limit/require-query-limit -- fixed parent cardinality",
  "// oxlint-disable-next-line no-console, require-query-limit/require-query-limit -- reviewed",
  "// eslint-disable -- a bare disable applies to every rule",
  "// eslint-disable-next-line no-console -- another rule only",
  "// eslint-disable-next-line no-console -- require-query-limit/require-query-limit remains enabled",
  "/* eslint-disable",
  " no-console",
  "*/ /* eslint-disable-next-line require-query-limit/require-query-limit -- second directive on the close line */",
  "/* oxlint-disable",
  " require-query-limit/require-query-limit",
  "*/",
  "/* eslint-disable",
  "*/",
  "// require-query-limit/require-query-limit in prose is not a directive",
  'const doc = "// eslint-disable-next-line require-query-limit/require-query-limit";',
  String.raw`const commentLike = /\/\//u; // eslint-disable-next-line require-query-limit/require-query-limit -- regex literal precedes the real directive`,
];
const SELF_TEST_REQUIRE_QUERY_LIMIT_SUPPRESSIONS = `${REQUIRE_QUERY_LIMIT_SUPPRESSION_FIXTURE_LINES.join("\n")}\n`;
// The fixtures carry three bare directives (one in the general lint fixture,
// two here). A bare directive names no rule, so it silences every rule and is
// charged to every tracked rule's budget — that is what keeps a bare disable
// from being a free pass through the per-rule budgets.
const EXPECTED_BARE_FIXTURE_DIRECTIVES = 3;

// Directives naming each tracked rule explicitly, across all fixtures. Total
// over the tracked-rule union, so adding a rule to the table forces a decision
// here instead of silently defaulting to zero. Each rule's expected budget is
// this plus EXPECTED_BARE_FIXTURE_DIRECTIVES.
//
// require-query-limit: five here (the `-- reason` trailer on the fifth line
// proves the rule list stops at the trailer, and the targeted directive on a
// multiline block's close line proves scanning resumes after the first block)
// plus one in the operational-script fixture, which also proves the budgets
// reach beyond `apps/*/src`.
const EXPECTED_NAMED_FIXTURE_SUPPRESSIONS = {
  "no-body-ownership-ids/no-body-ownership-ids": 0,
  "no-unbranded-ownership-id-param/no-unbranded-ownership-id-param": 0,
  "require-search-scope/require-search-scope": 0,
  "require-safe-route-handlers/require-safe-route-handlers": 0,
  "security-guards/no-raw-filename-write": 0,
  "security-guards/no-unsanitized-href": 0,
  "security-guards/no-unscoped-user-query": 0,
  "security-guards/require-secure-document-response": 0,
  "mcp-security/no-direct-oauth-client-join": 0,
  "mcp-security/redact-oauth-registration-response": 0,
  "auth-lifecycle/after-remove-member-revokes-artifacts": 0,
  "auth-lifecycle/no-direct-auth-artifact-delete": 0,
  "no-unowned-file-version-write/no-unowned-file-version-write": 0,
  "no-direct-audit-log-insert/no-direct-audit-log-insert": 0,
  "no-direct-buffer-cleanup-intent-delete/no-direct-buffer-cleanup-intent-delete": 0,
  "no-direct-ingestion-checkpoint-write/no-direct-ingestion-checkpoint-write": 0,
  "require-buffer-cleanup-intent-status/require-buffer-cleanup-intent-status": 0,
  "require-query-limit/require-query-limit": 6,
  "no-db-await-in-loop/no-db-await-in-loop": 0,
  "no-raw-use-effect/no-raw-use-effect": 2,
  "no-swallowed-rejection/no-swallowed-rejection": 0,
  "require-toast-error-capture/require-toast-error-capture": 0,
  "no-detached-void/no-detached-void": 0,
  "require-detached-label-shape/require-detached-label-shape": 0,
  "no-awaited-builder-union/no-awaited-builder-union": 0,
  "no-vacuous-throw-assertion/no-vacuous-throw-assertion": 0,
  "no-internal-module-mock/no-internal-module-mock": 0,
} as const satisfies Record<TrackedRule, number>;

const TS_SUPPRESSION_FIXTURE_LINES = [
  "// @ts-expect-error legacy upstream shape",
  "// @ts-ignore",
  "/* @ts-nocheck */",
  'const s = "// @ts-ignore inside a string"; // must not count',
  "// removing the last @ts-expect-error is the goal (mid-sentence mention must not count)",
];
const SELF_TEST_TS_SUPPRESSIONS = `${TS_SUPPRESSION_FIXTURE_LINES.join("\n")}\n`;
// Expected: the three directive lines; the string copy and the mid-sentence
// mention are excluded.
const EXPECTED_TS_SUPPRESSIONS = 3;

const DETACHED_PROMISE_FIXTURE_LINES = [
  "void saveDraft();",
  "const handler = () => void refreshData();",
  "void saveDraft().catch(reportError);",
  "void saveDraft().finally(markFinished);",
  "const button = <Button onClick={async () => saveDraft()} />;",
  "const form = <form onSubmit={async (event) => submit(event)} />;",
  "const sync = <Button onClick={() => saveDraft()} />;",
  'const doc = "void ignoredCall()";',
  "// void commentedOut();",
];
const SELF_TEST_DETACHED_PROMISES = `${DETACHED_PROMISE_FIXTURE_LINES.join("\n")}\n`;
// Expected: two void-detached calls, the `.finally(...)` chain (which can
// still reject), and two direct async JSX handlers. The terminal catch,
// synchronous JSX callback, string, and comment are excluded.
const EXPECTED_DETACHED_PROMISES = 5;

const CROSS_HANDLER_FIXTURE_LINES = [
  'import { origin } from "../skills/origin";',
  'import { local } from "./local-helper";',
  'import { schema } from "../pagination-limit-schema";',
  'import { db } from "../../db";',
  'const lazy = await import("../docx/extract-text");',
  'import { viaAlias } from "@/api/handlers/docx/extract-text";',
  'import { own } from "@/api/handlers/catalogue/local-helper";',
  'import { shared } from "@/api/lib/object";',
  'import { trailing } from "./other-local"; // import { c } from "../skills/in-a-trailing-comment";',
  '// import { c } from "../skills/commented";',
];
const SELF_TEST_CROSS_HANDLER = `${CROSS_HANDLER_FIXTURE_LINES.join("\n")}\n`;
// Expected (file lives in handlers/catalogue/): the ../skills/ static import,
// the ../docx/ dynamic import, and the @/api/-alias cross-import = 3.
// Same-domain (relative and alias forms), slice-root (a loose shared file
// directly under handlers/ resolves with an empty rest and is excluded on
// purpose), outside-handlers, trailing-comment, and comment-line imports
// don't count.
const EXPECTED_CROSS_HANDLER = 3;

const LIB_TO_HANDLER_FIXTURE_LINES = [
  'import { fileKey } from "../../handlers/files/utils";',
  'import { chat } from "@/api/handlers/chat/send-message";',
  'import { own } from "./own-helper";',
  'import { shared } from "@/api/lib/object";',
  'import { packageValue } from "@stll/shared";',
  '// import { ignored } from "@/api/handlers/entities/read";',
];
const SELF_TEST_LIB_TO_HANDLER = `${LIB_TO_HANDLER_FIXTURE_LINES.join("\n")}\n`;
const EXPECTED_LIB_TO_HANDLER = 2;

const CROSS_ROUTE_FIXTURE_LINES = [
  'import { w } from "@/routes/_protected.alpha/-components/widget";',
  'import { q } from "../_protected.alpha/-queries";',
  'import { own } from "./-components/own-widget";',
  'import { deep } from "@/routes/_protected.alpha/$id/-hooks/use-x";',
  'import { pub } from "@/routes/_protected.alpha/shared-public";',
  'import { Button } from "@coss/button";',
  '// import { c } from "@/routes/_protected.alpha/-components/commented";',
];
const SELF_TEST_CROSS_ROUTE = `${CROSS_ROUTE_FIXTURE_LINES.join("\n")}\n`;
// Expected (file lives in routes/_protected.beta/): alias cross-import,
// relative cross-import, and the nested `-hooks` under the other slice = 3.
// Own-slice private, other-slice non-private, package, and commented imports
// don't count.
const EXPECTED_CROSS_ROUTE_BETA = 3;

const CROSS_ROUTE_NESTED_FIXTURE_LINES = [
  'import { own } from "@/routes/_protected.alpha/-queries";',
  'import { other } from "@/routes/_protected.beta/-queries";',
];
const SELF_TEST_CROSS_ROUTE_NESTED = `${CROSS_ROUTE_NESTED_FIXTURE_LINES.join("\n")}\n`;
// Expected (file lives in routes/_protected.alpha/$id/, i.e. slice
// `_protected.alpha`): only the `_protected.beta` reach counts; the own-slice
// import from a NESTED dir proves attribution to the top-level route dir.
const EXPECTED_CROSS_ROUTE_NESTED = 1;

const CROSS_ROUTE_FILE_FIXTURE_LINES = [
  'import { own } from "@/routes/_protected.alpha/-queries";',
  'import { other } from "@/routes/_protected.beta/-queries";',
];
const SELF_TEST_CROSS_ROUTE_FILE = `${CROSS_ROUTE_FILE_FIXTURE_LINES.join("\n")}\n`;
// Expected (file IS the route file routes/_protected.alpha.tsx): its own
// dir's private import is same-slice after extension stripping; only the
// `_protected.beta` reach counts.
const EXPECTED_CROSS_ROUTE_FILE = 1;

const CROSS_ROUTE_CHROME_FIXTURE_LINES = [
  'import { q } from "@/routes/_protected.alpha/-queries";',
  'import { util } from "@/lib/utils";',
];
const SELF_TEST_CROSS_ROUTE_CHROME = `${CROSS_ROUTE_CHROME_FIXTURE_LINES.join("\n")}\n`;
// Expected (file lives OUTSIDE routes/, in components/): shared chrome
// reaching into any route-private path counts = 1.
const EXPECTED_CROSS_ROUTE_CHROME = 1;

const CROSS_FEATURE_FIXTURE_LINES = [
  'import { b } from "../beta/utils";',
  'import { own } from "./own-utils";',
  'import { shared } from "@/lib/utils";',
  'import { viaAlias } from "@/features/beta/other";',
];
const SELF_TEST_CROSS_FEATURE = `${CROSS_FEATURE_FIXTURE_LINES.join("\n")}\n`;
// Expected (file lives in features/alpha/): the relative and alias imports
// into features/beta = 2; own-feature and non-feature imports don't count.
const EXPECTED_CROSS_FEATURE = 2;

const SUPPRESSION_FIXTURE_LINES = [
  "// eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- reason one",
  "useEffect(() => {}, []);",
  "  // oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect -- reason two",
  "useEffect(() => {}, []);",
  'const doc = "// eslint-disable-next-line no-raw-use-effect/no-raw-use-effect"; // directive in a string must not count',
  "// the no-raw-use-effect/no-raw-use-effect rule is discussed here without a disable directive",
  "// eslint-disable-next-line react-hooks/exhaustive-deps -- other-rule directive must not count",
];
const SELF_TEST_SUPPRESSIONS = `${SUPPRESSION_FIXTURE_LINES.join("\n")}\n`;

const WORKSPACE_ONLY_RLS_FIXTURE_LINES = [
  "export const counted = p.pgTable(",
  '  "counted",',
  "  {",
  '    organizationId: safeOrganizationId("organization_id").notNull(),',
  '    workspaceId: safeWorkspaceId("workspace_id").notNull(),',
  "  },",
  "  (table) => [...wsPolicies()],",
  ");",
  "export const alsoCounted = p.pgTable(",
  '  "also_counted",',
  "  {",
  '    organizationId: safeOrganizationId("organization_id").notNull(),',
  '    workspaceId: safeWorkspaceId("workspace_id").notNull(),',
  "  },",
  "  (table) => [...wsPolicies()],",
  ");",
  "export const noOrgColumn = p.pgTable(",
  '  "no_org_column",',
  '  { workspaceId: safeWorkspaceId("workspace_id").notNull() },',
  "  (table) => [...wsPolicies()],",
  ");",
  "export const alreadyPinned = p.pgTable(",
  '  "already_pinned",',
  "  {",
  '    organizationId: safeOrganizationId("organization_id").notNull(),',
  '    workspaceId: safeWorkspaceId("workspace_id").notNull(),',
  "  },",
  '  (table) => [...wsOrganizationPolicies("already_pinned")],',
  ");",
  "export const orgScoped = p.pgTable(",
  '  "org_scoped",',
  '  { organizationId: safeOrganizationId("organization_id").notNull() },',
  "  (table) => [...orgPolicies()],",
  ");",
  "export const jsonPayloadOnly = p.pgTable(",
  '  "json_payload_only",',
  "  {",
  '    workspaceId: safeWorkspaceId("workspace_id").notNull(),',
  "    payload: jsonb().$type<{ organizationId: string }>(),",
  "  },",
  "  (table) => [...wsPolicies()],",
  ");",
  "// export const commented = p.pgTable(",
  '//   "commented",',
  '//   { organizationId: safeOrganizationId("organization_id").notNull() },',
  "//   (table) => [...wsPolicies()],",
  "// );",
];
const SELF_TEST_WORKSPACE_ONLY_RLS = `${WORKSPACE_ONLY_RLS_FIXTURE_LINES.join("\n")}\n`;

const THROW_OUTSIDE_BOUNDARY_FIXTURE_LINES = [
  "const single = () => {",
  '  throw new Error("bad");',
  "};",
  "const multiLine = () => {",
  "  throw new CustomError(",
  '    "bad",',
  "    { cause },",
  "  );",
  "};",
  "const factoryThrow = () => {",
  "  throw factory(x);",
  "};",
  'const standaloneError = new Error("not caught");',
  "const identifierThrow = () => {",
  "  throw standaloneError;",
  "};",
  "const rethrow = () => {",
  "  try {",
  "    work();",
  "  } catch (error) {",
  "    throw error;",
  "  }",
  "};",
  "const capturedRethrow = () => {",
  "  try {",
  "    work();",
  "  } catch (error) {",
  "    return () => {",
  "      throw error;",
  "    };",
  "  }",
  "};",
  "const shadowedRethrow = () => {",
  "  try {",
  "    work();",
  "  } catch (error) {",
  "    {",
  '      const error = new Error("shadowed");',
  "      throw error;",
  "    }",
  "  }",
  "};",
  "const invariant = () => {",
  '  throw panic("impossible state");',
  "};",
  '// throw new Error("commented out") must not count',
];
const SELF_TEST_THROW_OUTSIDE_BOUNDARY = `${THROW_OUTSIDE_BOUNDARY_FIXTURE_LINES.join("\n")}\n`;
// The lexical ratchet counts `single`, `multiLine`, and `factoryThrow` (3).
// Identifier throws are excluded from this debt budget; Oxlint performs the
// precise scope-aware enforcement on changed files. `throw panic(...)` and the
// commented-out throw are also excluded.
const EXPECTED_THROW_OUTSIDE_BOUNDARY = 3;

const TRY_CATCH_OUTSIDE_BOUNDARY_FIXTURE_LINES = [
  "const withBinding = () => {",
  "  try {",
  "    doSomething();",
  "  } catch (error) {",
  "    handle(error);",
  "  }",
  "};",
  "const withoutBinding = () => {",
  "  try {",
  "    doSomethingElse();",
  "  } catch {",
  "    handleElse();",
  "  }",
  "};",
  "const wrapped = Result.tryPromise({",
  "  try: () => doAsync(),",
  "  catch: (cause) => cause,",
  "});",
  "const cleanupOnly = () => {",
  "  try {",
  "    prepare();",
  "  } finally {",
  "    release();",
  "  }",
  "};",
  "// } catch (ignored) { must not count",
];
const SELF_TEST_TRY_CATCH_OUTSIDE_BOUNDARY = `${TRY_CATCH_OUTSIDE_BOUNDARY_FIXTURE_LINES.join("\n")}\n`;
// Expected: the two clauses above plus the three catch fixtures in
// SELF_TEST_THROW_OUTSIDE_BOUNDARY = 5. The `catch:` object key inside
// `Result.tryPromise`, the `try`/`finally` with no `catch`, and the commented-
// out clause are excluded.
const EXPECTED_TRY_CATCH_OUTSIDE_BOUNDARY = 5;

// A boundary file (matches RESULT_BOUNDARY_GLOBS) carrying the same shapes:
// proves the exclude, not just the counters.
const RESULT_BOUNDARY_FILE_FIXTURE_LINES = [
  "export const handleRequest = async (req) => {",
  "  try {",
  '    throw new Error("boundary throws are allowed here");',
  "  } catch (error) {",
  "    return toErrorResponse(error);",
  "  }",
  "};",
];
const SELF_TEST_RESULT_BOUNDARY_FILE = `${RESULT_BOUNDARY_FILE_FIXTURE_LINES.join("\n")}\n`;

// Two pairs in one file and one in another: the count is the number of
// ledger lines, not of files.
const SELF_TEST_INTERNAL_MODULE_MOCK_LEDGER = `${JSON.stringify(
  [
    "apps/api/src/handlers/alpha.test.ts::@/api/lib/s3",
    "apps/api/src/handlers/alpha.test.ts::@/api/lib/s3-presign",
    "packages/cli/src/login.test.ts::./browser-open.js",
  ],
  null,
  2,
)}\n`;
const EXPECTED_INTERNAL_MODULE_MOCK_LEDGER_ENTRIES = 3;
// Expected: the two tables that declare organizationId AND spread wsPolicies().
// Excluded: the workspace-only table with no organizationId column, the table
// already on wsOrganizationPolicies, the org-only table, the table whose only
// `organizationId:` sits mid-line inside a JSONB payload type rather than
// opening a column declaration, and the fully commented-out declaration — the
// last one proving the comment strip runs before the scan.
const EXPECTED_WORKSPACE_ONLY_RLS = 2;

const AD_HOC_SUBJECT_GATE_FIXTURE_LINES = [
  'import { isRedistributable } from "@/api/lib/legal-search/corpus-source";',
  "export const read = async (row: Row) => {",
  "  if (!isRedistributable(row.descriptor)) {",
  "    return null;",
  "  }",
  "  return row;",
  "};",
];
const SELF_TEST_AD_HOC_SUBJECT_GATE = `${AD_HOC_SUBJECT_GATE_FIXTURE_LINES.join("\n")}\n`;
// Expected: one call from the decisions fixture and one from the provisions
// fixture, so both `include` globs are exercised rather than only the first.
// The gate module's own call is excluded, which is the exclusion's whole job:
// counting it would make the metric un-zeroable and the guard meaningless.
const EXPECTED_AD_HOC_SUBJECT_GATES = 2;

// Repo-scope fixtures. These metrics compare files against each other, so the
// fixture is the layout, not one file's text: two apps holding the same path
// below src/lib, one exported name defined in three workspaces, and the direct
// children of the two lib buckets (including the ones that must not count).
const SELF_TEST_COPIED_HELPER = "const helper = 1;\n";
const API_SHARED_NAMES_FIXTURE_LINES = [
  "export const formatCitation = (value: string): string => value;",
  'export type CitationStyle = "bluebook";',
  "export const fmt = 1;",
];
const SELF_TEST_API_SHARED_NAMES = `${API_SHARED_NAMES_FIXTURE_LINES.join("\n")}\n`;
const WEB_MIRRORED_NAMES_FIXTURE_LINES = [
  "export const formatCitation = (value: string): string => value;",
  "export interface CitationStyle {",
  "  readonly name: string;",
  "}",
  "export default formatCitation;",
];
const SELF_TEST_WEB_MIRRORED_NAMES = `${WEB_MIRRORED_NAMES_FIXTURE_LINES.join("\n")}\n`;
const SELF_TEST_WEB_SECOND_DEFINITION =
  "export const formatCitation = (value: string): string => value;\n";
const SELF_TEST_PACKAGE_SHARED_NAMES =
  "export function formatCitation(value: string): string {\n  return value;\n}\n";
// The two `copied/duplicated-helper.ts` files, both sides counted. The
// same-basename pair in different directories (`alpha/types.ts` vs
// `beta/types.ts`), the unique `api-only-helper.ts`, and the `.test.ts` pair
// sharing a path are all excluded.
const EXPECTED_CROSS_APP_LIB_PATH_COPIES = 2;
// `formatCitation` in three workspaces (2 extra) + `CitationStyle` in two
// (1 extra) = 3. `fmt` is under the length floor, the default export carries
// no name, apps/web's second definition of `formatCitation` is the same
// workspace, and the generated package file is excluded outright, so none of
// them adds anything.
const EXPECTED_CROSS_WORKSPACE_DUPLICATE_EXPORT_NAMES = 3;
// apps/api/src/lib children: api-handlers.ts, result-catches.ts,
// result-throws.ts, shared/ (from the earlier fixtures), plus alpha/, copied/,
// api-only-helper.ts and shared-names.ts. The two `.test.ts` files, the
// `.type-test.ts` file, __fixtures__/, tests/ and __tests__/ are excluded.
const EXPECTED_API_LIB_TOP_LEVEL_ENTRIES = 8;
// apps/web/src/lib children: index.tsx (from the earlier fixtures), plus
// beta/, copied/, mirrored-names.ts and second-definition.ts. The `.test.ts`
// companion is excluded.
const EXPECTED_WEB_LIB_TOP_LEVEL_ENTRIES = 5;

// Duplicate-token-block fixtures. Ten lines of seven tokens each: 70 tokens, so
// the shared run clears the 60-token window with room to spare.
const CLONE_BLOCK_LINES = Array.from(
  { length: 10 },
  (_, index) =>
    `const step${String(index)} = compute(alpha, beta, gamma, delta);`,
);
const SELF_TEST_CLONE_BLOCK = `${CLONE_BLOCK_LINES.join("\n")}\n`;
// The same shape with a different vocabulary, so it shares no window with the
// block above: a long stretch of code is not by itself a copy.
const SELF_TEST_UNIQUE_BLOCK = `${Array.from(
  { length: 10 },
  (_, index) =>
    `const only${String(index)} = derive(epsilon, zeta, eta, theta);`,
).join("\n")}\n`;
// The shared block as the CONTENTS of a template literal. Blanking runs before
// tokenising, so nothing here is a token and the file cannot match anything.
const SELF_TEST_CLONE_IN_LITERAL = `const sql = \`\n${SELF_TEST_CLONE_BLOCK}\`;\n`;
// Adversarial pair: `contributorLastActivityMs` and `inspectedManifest` have
// the same 32-bit token hash, which both rolling hashes are built from, so
// these two blocks agree on BOTH hashes at every window while reading
// differently. Only the sequence check separates them.
const collidingBlock = (identifier: string) =>
  `${Array.from(
    { length: 10 },
    (_, index) =>
      `const near${String(index)} = collide(${identifier}, iota, kappa);`,
  ).join("\n")}\n`;
const SELF_TEST_CLONE_HASH_COLLISION_LEFT = collidingBlock(
  "contributorLastActivityMs",
);
const SELF_TEST_CLONE_HASH_COLLISION_RIGHT =
  collidingBlock("inspectedManifest");
// One block in each of the two files that share it. The unique block, the
// literal-only copy, the test-file copy and the hash-colliding pair all add
// nothing.
const EXPECTED_DUPLICATE_TOKEN_BLOCKS = 2;

const writeFixture = (root: string, rel: string, content: string): void => {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
};

// Two truncated entries among four, plus shapes the counter must NOT count:
// `inputSchemaTruncated: false`, and an entry that simply omits the field.
const SELF_TEST_CAPABILITY_CATALOG = `${JSON.stringify([
  { id: "alpha.create", inputSchemaTruncated: true },
  { id: "beta.read", inputSchemaTruncated: false },
  { id: "gamma.update" },
  { id: "delta.delete", inputSchemaTruncated: true },
  // Transport shapes: required file input, file response, BOTH legs (must count
  // once, not twice), a plain JSON transport, and an OPTIONAL file input (the
  // fileless-exposed shape, which must NOT count — it stays invokable).
  {
    id: "eta.create",
    transport: {
      type: "file-input",
      input: { field: "file", required: true, mediaTypes: [] },
      alternative: { type: "none", reason: "fixture" },
    },
  },
  {
    id: "theta.get",
    transport: {
      type: "file-response",
      response: { mediaTypes: ["application/pdf"] },
      alternative: { type: "none", reason: "fixture" },
    },
  },
  {
    id: "iota.update",
    transport: {
      type: "file-both",
      input: { field: "file", required: true, mediaTypes: [] },
      response: { mediaTypes: ["application/pdf"] },
      alternative: { type: "none", reason: "fixture" },
    },
  },
  { id: "kappa.delete", transport: { type: "json" } },
  {
    id: "kappa.prefill",
    transport: {
      type: "file-input",
      input: { field: "file", required: false, mediaTypes: [] },
      alternative: { type: "none", reason: "fixture" },
    },
  },
  // Read-scope shapes: two reads on a write-only scope MUST count, a read on a
  // read scope and a write on a write scope must NOT.
  { id: "lambda.list", access: "read", scope: "stella:matters_write" },
  { id: "mu.get", access: "read", scope: "stella:admin_write" },
  { id: "nu.get", access: "read", scope: "stella:read" },
  { id: "xi.create", access: "write", scope: "stella:matters_write" },
])}\n`;
// Two truncated entries in the catalog fixture.
const EXPECTED_TRUNCATED_CAPABILITY_SCHEMAS = 2;
// Three suppressed entries (required file input, file response, and the
// both-legs entry counted ONCE) in the catalog fixture; the plain JSON entry
// and the OPTIONAL-file-input entry are excluded.
const EXPECTED_FILE_TRANSPORT_SUPPRESSED = 3;
// Two read-on-write-scope entries (`lambda.list`, `mu.get`) in the catalog
// fixture; the read-on-read-scope and write-on-write-scope entries, and every
// earlier fixture entry lacking access/scope, are excluded.
const EXPECTED_READ_CAPABILITIES_WITH_WRITE_SCOPE = 2;

// The two better-result convention counters share one shape of check: the
// fixture count matches, and the boundary fixture file stays out of the
// per-file map.
const resultConventionSelfTestFailures = (snapshot: Baseline): string[] => {
  const failures: string[] = [];
  const checks = [
    { expected: EXPECTED_THROW_OUTSIDE_BOUNDARY, id: "throw-outside-boundary" },
    {
      expected: EXPECTED_TRY_CATCH_OUTSIDE_BOUNDARY,
      id: "try-catch-outside-boundary",
    },
  ] as const;
  for (const { expected, id } of checks) {
    const metric = requireSnapshot(snapshot, id);
    if (metric.count !== expected) {
      failures.push(`${id} counted ${metric.count}, expected ${expected}`);
    }
    if ("apps/api/src/lib/api-handlers.ts" in metric.files) {
      failures.push(`${id} did not exclude a RESULT_BOUNDARY_GLOBS file`);
    }
  }
  return failures;
};

// The repo-scope metrics assert on a layout rather than one file's text, so
// each check names the count it expects plus the files that must and must not
// appear in its per-file breakdown.
const repoScopeSelfTestFailures = (snapshot: Baseline): string[] => {
  const failures: string[] = [];
  const repoScopeChecks = [
    {
      id: "cross-app-lib-path-copies",
      expected: EXPECTED_CROSS_APP_LIB_PATH_COPIES,
      present: [
        "apps/api/src/lib/copied/duplicated-helper.ts",
        "apps/web/src/lib/copied/duplicated-helper.ts",
      ],
      absent: [
        "apps/api/src/lib/alpha/types.ts",
        "apps/web/src/lib/beta/types.ts",
        "apps/api/src/lib/api-only-helper.ts",
        "apps/web/src/lib/duplicated-helper.test.ts",
      ],
    },
    {
      id: "cross-workspace-duplicate-export-names",
      expected: EXPECTED_CROSS_WORKSPACE_DUPLICATE_EXPORT_NAMES,
      // apps/api owns both names, so the extras land on the other two
      // workspaces: two on apps/web's first defining file, one on the
      // package.
      present: [
        "apps/web/src/lib/mirrored-names.ts",
        "packages/example-package/src/index.ts",
      ],
      absent: [
        "apps/api/src/lib/shared-names.ts",
        "apps/web/src/lib/second-definition.ts",
        "packages/generated-package/src/generated/transport.ts",
      ],
    },
    {
      id: "duplicate-token-blocks",
      expected: EXPECTED_DUPLICATE_TOKEN_BLOCKS,
      present: ["apps/api/src/clone-origin.ts", "apps/web/src/clone-copy.ts"],
      absent: [
        "apps/api/src/clone-unique.ts",
        "apps/api/src/clone-in-literal.ts",
        "apps/api/src/clone-copy.test.ts",
        "apps/api/src/clone-collision-left.ts",
        "apps/web/src/clone-collision-right.ts",
      ],
    },
    {
      id: "api-lib-top-level-entries",
      expected: EXPECTED_API_LIB_TOP_LEVEL_ENTRIES,
      present: ["apps/api/src/lib/copied", "apps/api/src/lib/shared-names.ts"],
      absent: [
        "apps/api/src/lib/lib-entry.test.ts",
        "apps/api/src/lib/lib-entry.type-test.ts",
        "apps/api/src/lib/__fixtures__",
        "apps/api/src/lib/tests",
        "apps/api/src/lib/__tests__",
      ],
    },
    {
      id: "web-lib-top-level-entries",
      expected: EXPECTED_WEB_LIB_TOP_LEVEL_ENTRIES,
      present: ["apps/web/src/lib/mirrored-names.ts"],
      absent: ["apps/web/src/lib/duplicated-helper.test.ts"],
    },
  ] as const;
  for (const { id, expected, present, absent } of repoScopeChecks) {
    const metric = requireSnapshot(snapshot, id);
    if (metric.count !== expected) {
      failures.push(
        `${id} counted ${metric.count}, expected ${expected} (files: ${Object.keys(metric.files).join(", ")})`,
      );
    }
    for (const file of present) {
      if (!(file in metric.files)) {
        failures.push(`${id} did not count ${file}`);
      }
    }
    for (const file of absent) {
      if (file in metric.files) {
        failures.push(`${id} counted ${file}, which it must exclude`);
      }
    }
  }
  const duplicateNames = requireSnapshot(
    snapshot,
    "cross-workspace-duplicate-export-names",
  );
  if (duplicateNames.files["apps/web/src/lib/mirrored-names.ts"] !== 2) {
    failures.push(
      "cross-workspace-duplicate-export-names did not charge both duplicated names to the web file that defines them",
    );
  }
  return failures;
};

const runSelfTest = (): number => {
  const failures: string[] = [];
  const root = mkdtempSync(path.join(tmpdir(), "ratchet-selftest-"));

  const validConfiguration = inspectConfiguration([{ id: "one-metric" }], {
    "one-metric": {
      count: 2,
      files: { "apps/api/src/example.ts": 2 },
    },
  });
  if (validConfiguration.status !== "valid") {
    failures.push("configuration validation rejected a valid baseline");
  }

  const configurationRegressions = [
    {
      name: "duplicate metric IDs",
      inspection: inspectConfiguration(
        [{ id: "one-metric" }, { id: "one-metric" }],
        { "one-metric": { count: 0, files: {} } },
      ),
      expectedError: "is duplicated",
    },
    {
      name: "missing baseline metrics",
      inspection: inspectConfiguration([{ id: "one-metric" }], {}),
      expectedError: "is missing from baseline",
    },
    {
      name: "stale baseline metrics",
      inspection: inspectConfiguration([{ id: "one-metric" }], {
        "one-metric": { count: 0, files: {} },
        "removed-metric": { count: 0, files: {} },
      }),
      expectedError: "is not registered",
    },
    {
      name: "inconsistent snapshot totals",
      inspection: inspectConfiguration([{ id: "one-metric" }], {
        "one-metric": {
          count: 1,
          files: { "apps/api/src/example.ts": 2 },
        },
      }),
      expectedError: "does not equal its per-file total",
    },
    {
      name: "non-kebab-case metric IDs",
      inspection: inspectConfiguration([{ id: "One_Metric" }], {
        One_Metric: { count: 0, files: {} },
      }),
      expectedError: "is not kebab-case",
    },
    {
      name: "non-object baselines",
      inspection: inspectConfiguration([{ id: "one-metric" }], []),
      expectedError: "must be a JSON object",
    },
    {
      name: "invalid per-file counts",
      inspection: inspectConfiguration([{ id: "one-metric" }], {
        "one-metric": {
          count: 2,
          files: { "apps/api/src/example.ts": 0 },
        },
      }),
      expectedError: "has an invalid count for",
    },
  ] as const;

  for (const { name, inspection, expectedError } of configurationRegressions) {
    if (
      inspection.status !== "invalid" ||
      !inspection.errors.some((error) => error.includes(expectedError))
    ) {
      failures.push(`configuration validation did not reject ${name}`);
    }
  }

  try {
    writeFixture(root, "apps/api/src/casts.ts", SELF_TEST_AS_CASTS);
    writeFixture(root, "apps/web/src/nullish.ts", SELF_TEST_NULLISH);
    writeFixture(
      root,
      "apps/api/src/legacy-realtime-invalidations.ts",
      SELF_TEST_LEGACY_REALTIME_INVALIDATIONS,
    );
    writeFixture(
      root,
      "apps/api/src/mcp/static-tool-definitions.ts",
      SELF_TEST_LEGACY_MANUAL_MCP_INPUT_SCHEMAS,
    );
    writeFixture(
      root,
      "apps/web/src/entity-glyphs.tsx",
      SELF_TEST_ENTITY_GLYPHS,
    );
    writeFixture(
      root,
      "apps/web/src/shared-helper-shapes.tsx",
      SELF_TEST_SHARED_WEB_HELPERS,
    );
    writeFixture(
      root,
      "apps/api/src/shared-helper-shapes.ts",
      SELF_TEST_SHARED_API_HELPERS,
    );
    writeFixture(
      root,
      "apps/api/src/timestamp-boundaries.ts",
      SELF_TEST_TIMESTAMP_BOUNDARIES,
    );
    writeFixture(
      root,
      "apps/api/src/super-linear-regexes.ts",
      SELF_TEST_SUPER_LINEAR_REGEXES,
    );
    writeFixture(
      root,
      "apps/web/src/error-display.tsx",
      SELF_TEST_DIRECT_ERROR,
    );
    writeFixture(
      root,
      "apps/web/src/module-collections.ts",
      SELF_TEST_MODULE_COLLECTIONS,
    );
    writeFixture(
      root,
      "apps/web/src/effect-suppressions.tsx",
      SELF_TEST_SUPPRESSIONS,
    );
    writeFixture(
      root,
      "apps/api/src/lint-suppressions.ts",
      SELF_TEST_LINT_SUPPRESSIONS,
    );
    writeFixture(
      root,
      "apps/api/src/query-limit-suppressions.ts",
      SELF_TEST_REQUIRE_QUERY_LIMIT_SUPPRESSIONS,
    );
    writeFixture(
      root,
      "apps/api/scripts/query-limit-suppressions.ts",
      "// eslint-disable-next-line require-query-limit/require-query-limit -- operational job has a fixed input cap\n",
    );
    writeFixture(
      root,
      "apps/api/src/ts-suppressions.ts",
      SELF_TEST_TS_SUPPRESSIONS,
    );
    writeFixture(
      root,
      "apps/web/src/detached-promises.tsx",
      SELF_TEST_DETACHED_PROMISES,
    );
    writeFixture(
      root,
      "apps/api/src/handlers/catalogue/uses-skills.ts",
      SELF_TEST_CROSS_HANDLER,
    );
    writeFixture(
      root,
      "apps/api/src/lib/shared/uses-handlers.ts",
      SELF_TEST_LIB_TO_HANDLER,
    );
    writeFixture(
      root,
      "apps/web/src/routes/_protected.beta/uses-alpha.tsx",
      SELF_TEST_CROSS_ROUTE,
    );
    writeFixture(
      root,
      "apps/web/src/routes/_protected.alpha/$id/nested.tsx",
      SELF_TEST_CROSS_ROUTE_NESTED,
    );
    writeFixture(
      root,
      "apps/web/src/routes/_protected.alpha.tsx",
      SELF_TEST_CROSS_ROUTE_FILE,
    );
    writeFixture(
      root,
      "apps/web/src/components/chrome.tsx",
      SELF_TEST_CROSS_ROUTE_CHROME,
    );
    writeFixture(
      root,
      "apps/web/src/features/alpha/uses-beta.ts",
      SELF_TEST_CROSS_FEATURE,
    );
    writeFixture(
      root,
      "apps/api/src/db/schema/workspace-only-rls.ts",
      SELF_TEST_WORKSPACE_ONLY_RLS,
    );
    writeFixture(
      root,
      "apps/api/src/lib/result-throws.ts",
      SELF_TEST_THROW_OUTSIDE_BOUNDARY,
    );
    writeFixture(
      root,
      "apps/api/src/lib/result-catches.ts",
      SELF_TEST_TRY_CATCH_OUTSIDE_BOUNDARY,
    );
    // Boundary file: matches RESULT_BOUNDARY_GLOBS (apps/api/src/lib/api-
    // handlers.ts), so throws and catches here must not be counted.
    writeFixture(
      root,
      "apps/api/src/lib/api-handlers.ts",
      SELF_TEST_RESULT_BOUNDARY_FILE,
    );
    writeFixture(
      root,
      "packages/cli/capability-catalog.json",
      SELF_TEST_CAPABILITY_CATALOG,
    );
    // Both handler globs the subject-gate metric covers, plus the gate module
    // itself, so the exclusion is exercised rather than assumed.
    writeFixture(
      root,
      "apps/api/src/handlers/case-law/decisions/ad-hoc.ts",
      SELF_TEST_AD_HOC_SUBJECT_GATE,
    );
    writeFixture(
      root,
      "apps/api/src/handlers/case-law/provisions/ad-hoc.ts",
      SELF_TEST_AD_HOC_SUBJECT_GATE,
    );
    writeFixture(
      root,
      "apps/api/src/handlers/case-law/decisions/public-subject.ts",
      SELF_TEST_AD_HOC_SUBJECT_GATE,
    );
    writeFixture(
      root,
      INTERNAL_MODULE_MOCK_LEDGER_REL,
      SELF_TEST_INTERNAL_MODULE_MOCK_LEDGER,
    );
    writeFixture(root, "apps/api/src/db/index.ts", "export const x = 1;\n");
    writeFixture(root, "apps/web/src/lib/index.tsx", "export const y = 2;\n");
    // Repo-scope layout fixtures.
    writeFixture(
      root,
      "apps/api/src/lib/copied/duplicated-helper.ts",
      SELF_TEST_COPIED_HELPER,
    );
    writeFixture(
      root,
      "apps/web/src/lib/copied/duplicated-helper.ts",
      SELF_TEST_COPIED_HELPER,
    );
    // Same path below src/lib in both apps, but test files: excluded.
    writeFixture(
      root,
      "apps/api/src/lib/duplicated-helper.test.ts",
      SELF_TEST_COPIED_HELPER,
    );
    writeFixture(
      root,
      "apps/web/src/lib/duplicated-helper.test.ts",
      SELF_TEST_COPIED_HELPER,
    );
    // Same basename under different domain directories: a convention, not a
    // copy.
    writeFixture(
      root,
      "apps/api/src/lib/alpha/types.ts",
      SELF_TEST_COPIED_HELPER,
    );
    writeFixture(
      root,
      "apps/web/src/lib/beta/types.ts",
      SELF_TEST_COPIED_HELPER,
    );
    writeFixture(
      root,
      "apps/api/src/lib/api-only-helper.ts",
      SELF_TEST_COPIED_HELPER,
    );
    writeFixture(
      root,
      "apps/api/src/lib/shared-names.ts",
      SELF_TEST_API_SHARED_NAMES,
    );
    writeFixture(
      root,
      "apps/web/src/lib/mirrored-names.ts",
      SELF_TEST_WEB_MIRRORED_NAMES,
    );
    writeFixture(
      root,
      "apps/web/src/lib/second-definition.ts",
      SELF_TEST_WEB_SECOND_DEFINITION,
    );
    writeFixture(
      root,
      "packages/example-package/src/index.ts",
      SELF_TEST_PACKAGE_SHARED_NAMES,
    );
    // A fourth workspace defining the same name, in a generated directory:
    // excluded, so it must not add an extra.
    writeFixture(
      root,
      "packages/generated-package/src/generated/transport.ts",
      SELF_TEST_PACKAGE_SHARED_NAMES,
    );
    // Excluded lib-bucket children: a test file, a compile-time type test, and
    // the fixture and test directories.
    writeFixture(
      root,
      "apps/api/src/lib/lib-entry.test.ts",
      SELF_TEST_COPIED_HELPER,
    );
    writeFixture(
      root,
      "apps/api/src/lib/lib-entry.type-test.ts",
      SELF_TEST_COPIED_HELPER,
    );
    writeFixture(
      root,
      "apps/api/src/lib/__fixtures__/sample.ts",
      SELF_TEST_COPIED_HELPER,
    );
    writeFixture(
      root,
      "apps/api/src/lib/tests/helper.ts",
      SELF_TEST_COPIED_HELPER,
    );
    writeFixture(
      root,
      "apps/api/src/lib/__tests__/helper.ts",
      SELF_TEST_COPIED_HELPER,
    );
    // Duplicate-token-block layout: two files sharing a 70-token run, a file
    // whose long run is its own, the same run reachable only inside a string
    // literal, and a test-file copy the scan excludes outright.
    writeFixture(root, "apps/api/src/clone-origin.ts", SELF_TEST_CLONE_BLOCK);
    writeFixture(root, "apps/web/src/clone-copy.ts", SELF_TEST_CLONE_BLOCK);
    writeFixture(root, "apps/api/src/clone-unique.ts", SELF_TEST_UNIQUE_BLOCK);
    writeFixture(
      root,
      "apps/api/src/clone-in-literal.ts",
      SELF_TEST_CLONE_IN_LITERAL,
    );
    writeFixture(
      root,
      "apps/api/src/clone-copy.test.ts",
      SELF_TEST_CLONE_BLOCK,
    );
    writeFixture(
      root,
      "apps/api/src/clone-collision-left.ts",
      SELF_TEST_CLONE_HASH_COLLISION_LEFT,
    );
    writeFixture(
      root,
      "apps/web/src/clone-collision-right.ts",
      SELF_TEST_CLONE_HASH_COLLISION_RIGHT,
    );
    // Excluded companions: these must NOT be counted.
    writeFixture(
      root,
      "apps/api/src/casts.test.ts",
      "const z = value as Widget;\n",
    );
    writeFixture(root, "apps/web/src/types.gen.ts", "const g = x as Y;\n");

    const snapshot = scanAll(root);

    const asMetric = requireSnapshot(snapshot, "as-casts");
    if (asMetric.count !== EXPECTED_AS_CASTS) {
      failures.push(
        `as-casts counted ${asMetric.count}, expected ${EXPECTED_AS_CASTS}`,
      );
    }
    if ("apps/api/src/casts.test.ts" in asMetric.files) {
      failures.push("as-casts did not exclude a .test.ts file");
    }
    if ("apps/web/src/types.gen.ts" in asMetric.files) {
      failures.push("as-casts did not exclude a .gen.ts file");
    }

    const mockLedgerMetric = requireSnapshot(
      snapshot,
      "internal-module-mock-ledger-entries",
    );
    if (
      mockLedgerMetric.count !== EXPECTED_INTERNAL_MODULE_MOCK_LEDGER_ENTRIES
    ) {
      failures.push(
        `internal-module-mock-ledger-entries counted ${mockLedgerMetric.count}, expected ${EXPECTED_INTERNAL_MODULE_MOCK_LEDGER_ENTRIES}`,
      );
    }

    const nullishMetric = requireSnapshot(snapshot, "nullish-array-fallback");
    if (nullishMetric.count !== EXPECTED_NULLISH) {
      failures.push(
        `nullish-array-fallback counted ${nullishMetric.count}, expected ${EXPECTED_NULLISH}`,
      );
    }

    const legacyRealtimeMetric = requireSnapshot(
      snapshot,
      "legacy-realtime-invalidation-producers",
    );
    if (legacyRealtimeMetric.count !== EXPECTED_LEGACY_REALTIME_INVALIDATIONS) {
      failures.push(
        `legacy-realtime-invalidation-producers counted ${legacyRealtimeMetric.count}, expected ${EXPECTED_LEGACY_REALTIME_INVALIDATIONS}`,
      );
    }

    const legacyManualMcpInputSchemaMetric = requireSnapshot(
      snapshot,
      "legacy-manual-mcp-input-schemas",
    );
    if (
      legacyManualMcpInputSchemaMetric.count !==
      EXPECTED_LEGACY_MANUAL_MCP_INPUT_SCHEMAS
    ) {
      failures.push(
        `legacy-manual-mcp-input-schemas counted ${legacyManualMcpInputSchemaMetric.count}, expected ${EXPECTED_LEGACY_MANUAL_MCP_INPUT_SCHEMAS}`,
      );
    }

    const adHocSubjectGateMetric = requireSnapshot(
      snapshot,
      "ad-hoc-decision-subject-gates",
    );
    if (adHocSubjectGateMetric.count !== EXPECTED_AD_HOC_SUBJECT_GATES) {
      failures.push(
        `ad-hoc-decision-subject-gates counted ${adHocSubjectGateMetric.count}, expected ${EXPECTED_AD_HOC_SUBJECT_GATES}`,
      );
    }
    for (const glob of [
      "apps/api/src/handlers/case-law/decisions/ad-hoc.ts",
      "apps/api/src/handlers/case-law/provisions/ad-hoc.ts",
    ]) {
      if (!(glob in adHocSubjectGateMetric.files)) {
        failures.push(`ad-hoc-decision-subject-gates did not scan ${glob}`);
      }
    }
    if (
      "apps/api/src/handlers/case-law/decisions/public-subject.ts" in
      adHocSubjectGateMetric.files
    ) {
      failures.push(
        "ad-hoc-decision-subject-gates did not exclude the gate module",
      );
    }

    const entityGlyphMetric = requireSnapshot(
      snapshot,
      "entity-kind-glyph-adhoc",
    );
    if (entityGlyphMetric.count !== EXPECTED_ENTITY_GLYPHS) {
      failures.push(
        `entity-kind-glyph-adhoc counted ${entityGlyphMetric.count}, expected ${EXPECTED_ENTITY_GLYPHS}`,
      );
    }

    const sharedHelperMetricExpectations = [
      ["hand-rolled-user-identity", EXPECTED_HAND_ROLLED_USER_IDENTITIES],
      ["raw-user-avatar-primitive", EXPECTED_RAW_USER_AVATAR_PRIMITIVES],
      ["shadowed-user-name-helpers", EXPECTED_SHADOWED_USER_NAME_HELPERS],
      [
        "ad-hoc-relative-time-formatting",
        EXPECTED_AD_HOC_RELATIVE_TIME_FORMATTING,
      ],
      ["direct-audit-log-insert", EXPECTED_DIRECT_AUDIT_LOG_INSERTS],
      ["inline-timestamp-cursor-sql", EXPECTED_INLINE_TIMESTAMP_CURSOR_SQL],
      [
        "repeated-timestamp-cursor-boundary",
        EXPECTED_REPEATED_TIMESTAMP_CURSOR_BOUNDARIES,
      ],
    ] as const;
    for (const [id, expected] of sharedHelperMetricExpectations) {
      const metric = requireSnapshot(snapshot, id);
      if (metric.count !== expected) {
        failures.push(`${id} counted ${metric.count}, expected ${expected}`);
      }
    }

    const superLinearMetric = requireSnapshot(snapshot, "super-linear-regexes");
    if (superLinearMetric.count !== EXPECTED_SUPER_LINEAR_REGEXES) {
      failures.push(
        `super-linear-regexes counted ${superLinearMetric.count}, expected ${EXPECTED_SUPER_LINEAR_REGEXES}`,
      );
    }

    const barrelMetric = requireSnapshot(snapshot, "barrel-index-files");
    if (barrelMetric.count !== 2) {
      failures.push(
        `barrel-index-files counted ${barrelMetric.count}, expected 2`,
      );
    }

    const directErrorMetric = requireSnapshot(
      snapshot,
      "direct-error-message-display",
    );
    if (directErrorMetric.count !== EXPECTED_DIRECT_ERROR) {
      failures.push(
        `direct-error-message-display counted ${directErrorMetric.count}, expected ${EXPECTED_DIRECT_ERROR}`,
      );
    }

    const moduleCollectionsMetric = requireSnapshot(
      snapshot,
      "module-level-mutable-collections",
    );
    if (moduleCollectionsMetric.count !== EXPECTED_MODULE_COLLECTIONS) {
      failures.push(
        `module-level-mutable-collections counted ${moduleCollectionsMetric.count}, expected ${EXPECTED_MODULE_COLLECTIONS}`,
      );
    }

    for (const [rule, named] of Object.entries(
      EXPECTED_NAMED_FIXTURE_SUPPRESSIONS,
    )) {
      const id = suppressionMetricId(rule);
      const expected = named + EXPECTED_BARE_FIXTURE_DIRECTIVES;
      const budget = requireSnapshot(snapshot, id);
      if (budget.count !== expected) {
        failures.push(`${id} counted ${budget.count}, expected ${expected}`);
      }
    }

    const lintSuppressionMetric = requireSnapshot(
      snapshot,
      "lint-suppression-directives",
    );
    if (lintSuppressionMetric.count !== EXPECTED_LINT_SUPPRESSIONS_TOTAL) {
      failures.push(
        `lint-suppression-directives counted ${lintSuppressionMetric.count}, expected ${EXPECTED_LINT_SUPPRESSIONS_TOTAL}`,
      );
    }
    if (
      lintSuppressionMetric.files["apps/api/src/lint-suppressions.ts"] !==
      EXPECTED_LINT_SUPPRESSIONS_OWN_FILE
    ) {
      failures.push(
        `lint-suppression-directives per-file count for the dedicated fixture was ${lintSuppressionMetric.files["apps/api/src/lint-suppressions.ts"]}, expected ${EXPECTED_LINT_SUPPRESSIONS_OWN_FILE}`,
      );
    }

    // The partition, on the one fixture that mixes both kinds: ten directives,
    // seven charged to the require-query-limit budget (five naming it, two
    // bare), three left over for the residual budget. A file whose residual
    // count silently absorbed its tracked directives would be the fungibility
    // bug this design exists to kill.
    const MIXED_FIXTURE = "apps/api/src/query-limit-suppressions.ts";
    const mixedResidual = lintSuppressionMetric.files[MIXED_FIXTURE];
    const mixedTracked = requireSnapshot(
      snapshot,
      "require-query-limit-suppressions",
    ).files[MIXED_FIXTURE];
    if (mixedResidual !== 3 || mixedTracked !== 7) {
      failures.push(
        `suppression budgets did not partition ${MIXED_FIXTURE}: residual ${mixedResidual} (expected 3), require-query-limit ${mixedTracked} (expected 7)`,
      );
    }

    // Every tracked rule reaches the metric registry. The other direction —
    // a registered metric with no baseline entry, or the reverse — is already
    // enforced by `inspectConfiguration`, so a rule added to the table without
    // a `--write` fails loudly instead of going quietly unbudgeted.
    const budgetIds = new Set(RATCHET_METRICS.map(({ id }) => id));
    for (const { rule } of TRACKED_SUPPRESSION_RULES) {
      if (!budgetIds.has(suppressionMetricId(rule))) {
        failures.push(`tracked rule ${rule} has no ratchet budget`);
      }
    }

    const tsSuppressionMetric = requireSnapshot(
      snapshot,
      "ts-suppression-directives",
    );
    if (tsSuppressionMetric.count !== EXPECTED_TS_SUPPRESSIONS) {
      failures.push(
        `ts-suppression-directives counted ${tsSuppressionMetric.count}, expected ${EXPECTED_TS_SUPPRESSIONS}`,
      );
    }

    const detachedPromiseMetric = requireSnapshot(
      snapshot,
      "detached-promise-review-sites",
    );
    if (detachedPromiseMetric.count !== EXPECTED_DETACHED_PROMISES) {
      failures.push(
        `detached-promise-review-sites counted ${detachedPromiseMetric.count}, expected ${EXPECTED_DETACHED_PROMISES}`,
      );
    }

    const truncatedCapabilityMetric = requireSnapshot(
      snapshot,
      "capability-schemas-truncated",
    );
    if (
      truncatedCapabilityMetric.count !== EXPECTED_TRUNCATED_CAPABILITY_SCHEMAS
    ) {
      failures.push(
        `capability-schemas-truncated counted ${truncatedCapabilityMetric.count}, expected ${EXPECTED_TRUNCATED_CAPABILITY_SCHEMAS}`,
      );
    }

    const fileTransportMetric = requireSnapshot(
      snapshot,
      "capability-file-transport-suppressed",
    );
    if (fileTransportMetric.count !== EXPECTED_FILE_TRANSPORT_SUPPRESSED) {
      failures.push(
        `capability-file-transport-suppressed counted ${fileTransportMetric.count}, expected ${EXPECTED_FILE_TRANSPORT_SUPPRESSED}`,
      );
    }

    const readWriteScopeMetric = requireSnapshot(
      snapshot,
      "read-capabilities-with-write-scope",
    );
    if (
      readWriteScopeMetric.count !== EXPECTED_READ_CAPABILITIES_WITH_WRITE_SCOPE
    ) {
      failures.push(
        `read-capabilities-with-write-scope counted ${readWriteScopeMetric.count}, expected ${EXPECTED_READ_CAPABILITIES_WITH_WRITE_SCOPE}`,
      );
    }

    const crossHandlerMetric = requireSnapshot(
      snapshot,
      "cross-handler-imports",
    );
    if (crossHandlerMetric.count !== EXPECTED_CROSS_HANDLER) {
      failures.push(
        `cross-handler-imports counted ${crossHandlerMetric.count}, expected ${EXPECTED_CROSS_HANDLER}`,
      );
    }

    const libToHandlerMetric = requireSnapshot(
      snapshot,
      "lib-to-handler-imports",
    );
    if (libToHandlerMetric.count !== EXPECTED_LIB_TO_HANDLER) {
      failures.push(
        `lib-to-handler-imports counted ${libToHandlerMetric.count}, expected ${EXPECTED_LIB_TO_HANDLER}`,
      );
    }

    const crossRouteMetric = requireSnapshot(
      snapshot,
      "cross-route-private-imports",
    );
    const expectedCrossRouteTotal =
      EXPECTED_CROSS_ROUTE_BETA +
      EXPECTED_CROSS_ROUTE_NESTED +
      EXPECTED_CROSS_ROUTE_FILE +
      EXPECTED_CROSS_ROUTE_CHROME;
    if (crossRouteMetric.count !== expectedCrossRouteTotal) {
      failures.push(
        `cross-route-private-imports counted ${crossRouteMetric.count}, expected ${expectedCrossRouteTotal}`,
      );
    }
    if (
      crossRouteMetric.files[
        "apps/web/src/routes/_protected.alpha/$id/nested.tsx"
      ] !== EXPECTED_CROSS_ROUTE_NESTED
    ) {
      failures.push(
        "cross-route-private-imports did not attribute a nested route file to its top-level slice",
      );
    }

    const crossFeatureMetric = requireSnapshot(
      snapshot,
      "cross-feature-imports",
    );
    if (crossFeatureMetric.count !== EXPECTED_CROSS_FEATURE) {
      failures.push(
        `cross-feature-imports counted ${crossFeatureMetric.count}, expected ${EXPECTED_CROSS_FEATURE}`,
      );
    }

    const workspaceOnlyRlsMetric = requireSnapshot(
      snapshot,
      "workspace-only-rls-on-org-tables",
    );
    if (workspaceOnlyRlsMetric.count !== EXPECTED_WORKSPACE_ONLY_RLS) {
      failures.push(
        `workspace-only-rls-on-org-tables counted ${workspaceOnlyRlsMetric.count}, expected ${EXPECTED_WORKSPACE_ONLY_RLS}`,
      );
    }

    failures.push(...repoScopeSelfTestFailures(snapshot));

    failures.push(...resultConventionSelfTestFailures(snapshot));

    // The subject-gate counter reads calls, not text: a mention in a comment
    // or a string, and a method of the same name on some object, are not the
    // hand-rolled gate the metric is holding at zero.
    const redistributableCases = [
      {
        code: "if (!isRedistributable(row.descriptor)) return null;",
        expected: 1,
      },
      {
        code: "// isRedistributable(row) used to live here\nconst a = 1;",
        expected: 0,
      },
      {
        code: 'const message = "call isRedistributable(x) instead";',
        expected: 0,
      },
      { code: "if (source.isRedistributable(row)) return row;", expected: 0 },
      {
        code: "isRedistributable(a); isRedistributable(b);",
        expected: 2,
      },
    ];
    for (const { code, expected } of redistributableCases) {
      const counted = countDirectRedistributableCalls(code);
      if (counted !== expected) {
        failures.push(
          `ad-hoc-decision-subject-gates counted ${counted}, expected ${expected}, for: ${code.replaceAll("\n", " ")}`,
        );
      }
    }

    // Diff behavior: equal passes, a rise regresses, a fall is a drop.
    const equal = diffMetric(
      "as-casts",
      { count: 4, files: { "a.ts": 4 } },
      { count: 4, files: { "a.ts": 4 } },
    );
    if (equal.status !== "ok") {
      failures.push("diffMetric flagged an equal count as not ok");
    }

    const rose = diffMetric(
      "as-casts",
      { count: 5, files: { "a.ts": 5 } },
      { count: 4, files: { "a.ts": 4 } },
    );
    if (rose.status !== "regressed" || rose.regressedFiles.length !== 1) {
      failures.push("diffMetric did not flag an increased count as regressed");
    }

    const fell = diffMetric(
      "as-casts",
      { count: 3, files: { "a.ts": 3 } },
      { count: 4, files: { "a.ts": 4 } },
    );
    if (fell.status !== "dropped") {
      failures.push("diffMetric did not flag a decreased count as dropped");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error("ratchet --self-test: FAIL");
    for (const f of failures) {
      console.error(`  ${f}`);
    }
    return 1;
  }
  console.log("ratchet --self-test: PASS");
  return 0;
};

// --- Entry ------------------------------------------------------------------

const main = (): number => {
  if (process.argv.includes("--self-test")) {
    return runSelfTest();
  }
  if (process.argv.includes("--write")) {
    return runWrite();
  }
  if (process.argv.includes("--check")) {
    return runCheck();
  }
  return runReport();
};

if (import.meta.main) {
  process.exit(main());
}
