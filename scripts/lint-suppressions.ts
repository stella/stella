// Lint-suppression registry and directive scanner.
//
// Shared by the two guards that govern lint suppressions:
//
//   scripts/ratchet.ts             per-rule decrease-only budgets, plus the
//                                  residual budget for every untracked rule
//   scripts/suppression-waivers.ts the security-tier waiver ledger
//
// One module owns the tracked-rule table, the directive scanner, and the
// anchor resolver so the budget and the ledger can never disagree about what
// counts as a suppression of a tracked rule.
//
// Budget model: every disable directive belongs to exactly ONE budget. A
// directive naming at least one tracked rule is charged to that rule's
// per-rule budget; a directive naming only untracked rules is charged to the
// residual budget. A bare directive (no rule list) silences every rule, so it
// is charged to every tracked rule's budget and to none of the residual. The
// partition is what makes the counts non-fungible: removing a style waiver
// cannot fund a new security waiver, because the two live in different
// budgets and the security budget rises on its own.

import { panic } from "better-result";
import ts from "typescript";

// --- Tracked rules ----------------------------------------------------------

// A `security` rule guards a tenancy, authorization, credential, or audit
// boundary: a suppression is a standing exception to an access-control
// invariant, so it additionally needs a ledger entry
// (scripts/suppression-waivers.json).
//
// A `data-volume` rule guards a capacity budget — an unbounded read, an N+1
// query, or a pattern that blows up compiler work the way an unbounded read
// blows up database work. A suppression is a capacity decision, reviewable
// from the per-rule baseline diff alone.
// An `observability` rule guards an error that reaches a user or a log: a
// suppression means a failure the product can no longer explain, which is a
// diagnosability decision rather than a tenancy or capacity one. Like
// `data-volume` and unlike `security`, it carries a per-rule budget but no
// waiver ledger: the exceptions are numerous and individually cheap to read
// from the baseline diff, and none of them stands down an authorization check.
// A `test-integrity` rule guards the assertion itself rather than the product:
// it rejects a test shape that keeps passing after the behavior it was written
// for is gone. A suppression here means one guard has been downgraded to a
// smoke check, which is a coverage decision readable from the baseline diff
// alone. Like `data-volume` and `observability`, it carries a per-rule budget
// and no waiver ledger.
export const SUPPRESSION_TIERS = [
  "security",
  "data-volume",
  "observability",
  "test-integrity",
] as const;

export type SuppressionTier = (typeof SUPPRESSION_TIERS)[number];

type TrackedSuppressionRule = {
  // Full oxlint rule ID (`<plugin>/<rule>`), exactly as `oxlint.config.ts`
  // enables it and as a disable directive must spell it.
  readonly rule: string;
  readonly tier: SuppressionTier;
  // The invariant a suppression of this rule stands down, in one line. Feeds
  // the ratchet metric description so the budget explains itself in CI output.
  readonly guards: string;
};

// Curated from `.oxlint-plugins/` by category. Security tier: the tenancy /
// authorization / credential / audit rules, including every rule whose README
// row describes an ownership or authorization boundary. Data-volume tier: the
// unbounded-read and N+1 rules.
//
// Adding a rule here is free when its current count is 0 and permanent
// thereafter: the baseline can only shrink.
export const TRACKED_SUPPRESSION_RULES = [
  {
    rule: "no-body-ownership-ids/no-body-ownership-ids",
    tier: "security",
    guards: "cross-tenant reads driven by request-body ownership IDs",
  },
  {
    rule: "no-unbranded-ownership-id-param/no-unbranded-ownership-id-param",
    tier: "security",
    guards: "validated ownership IDs decaying back into plain strings",
  },
  {
    rule: "require-search-scope/require-search-scope",
    tier: "security",
    guards: "private search projections read without an authorization fragment",
  },
  {
    rule: "require-safe-route-handlers/require-safe-route-handlers",
    tier: "security",
    guards: "authenticated routes mounting handlers outside the safe wrapper",
  },
  {
    rule: "security-guards/no-raw-filename-write",
    tier: "security",
    guards: "unsanitized user filenames reaching storage",
  },
  {
    rule: "security-guards/no-unsanitized-href",
    tier: "security",
    guards: "unsanitized external URLs reaching an href sink",
  },
  {
    rule: "security-guards/no-unscoped-user-query",
    tier: "security",
    guards: "auth user reads without an organization-scoping join",
  },
  {
    rule: "security-guards/require-secure-document-response",
    tier: "security",
    guards: "document responses served without their security headers",
  },
  {
    rule: "mcp-security/no-direct-oauth-client-join",
    tier: "security",
    guards: "OAuth client rows loaded outside the typed connection loader",
  },
  {
    rule: "mcp-security/redact-oauth-registration-response",
    tier: "security",
    guards: "unredacted OAuth registration secrets persisted to JSONB",
  },
  {
    rule: "auth-lifecycle/after-remove-member-revokes-artifacts",
    tier: "security",
    guards: "membership removal leaving auth artifacts behind",
  },
  {
    rule: "auth-lifecycle/no-direct-auth-artifact-delete",
    tier: "security",
    guards: "auth artifact deletion bypassing the revocation helper",
  },
  {
    rule: "no-unowned-file-version-write/no-unowned-file-version-write",
    tier: "security",
    guards: "file-version writes with no proven owning entity",
  },
  {
    rule: "no-direct-audit-log-insert/no-direct-audit-log-insert",
    tier: "security",
    guards: "audit rows written outside the audit-log recorder",
  },
  {
    rule: "no-direct-ingestion-checkpoint-write/no-direct-ingestion-checkpoint-write",
    tier: "security",
    guards: "ingestion checkpoints advanced outside the replay-safe boundary",
  },
  {
    rule: "require-buffer-cleanup-intent-status/require-buffer-cleanup-intent-status",
    tier: "security",
    guards:
      "cleanup-intent inserts that silently inherit a lifecycle state",
  },
  {
    rule: "require-query-limit/require-query-limit",
    tier: "data-volume",
    guards: "unbounded Drizzle list reads",
  },
  {
    rule: "no-db-await-in-loop/no-db-await-in-loop",
    tier: "data-volume",
    guards: "per-row database round-trips inside a loop (N+1)",
  },
  {
    rule: "no-raw-use-effect/no-raw-use-effect",
    tier: "data-volume",
    guards: "raw effects outside the sanctioned effect wrappers",
  },
  {
    rule: "no-awaited-builder-union/no-awaited-builder-union",
    tier: "data-volume",
    guards:
      "awaited ternaries over two chain states of one query builder, which instantiate both builder types and their union",
  },
  {
    rule: "no-swallowed-rejection/no-swallowed-rejection",
    tier: "observability",
    guards: "promise rejections discarded without capture",
  },
  {
    rule: "require-toast-error-capture/require-toast-error-capture",
    tier: "observability",
    guards: "error toasts shown without capturing the error behind them",
  },
  {
    rule: "no-detached-void/no-detached-void",
    tier: "observability",
    guards: "detached `void` calls with no rejection handler",
  },
  {
    rule: "require-detached-label-shape/require-detached-label-shape",
    tier: "observability",
    guards:
      "detached-promise labels that cannot correlate a captured rejection to a call site",
  },
  {
    rule: "no-vacuous-throw-assertion/no-vacuous-throw-assertion",
    tier: "test-integrity",
    guards:
      "throw assertions that pin no error, so any unrelated failure keeps them green",
  },
  {
    rule: "no-internal-module-mock/no-internal-module-mock",
    tier: "test-integrity",
    guards:
      "module mocks of workspace modules, which keep a test green after the mocked contract changes",
  },
] as const satisfies readonly TrackedSuppressionRule[];

export type TrackedRule = (typeof TRACKED_SUPPRESSION_RULES)[number]["rule"];

// Widened to `string` on purpose: callers ask whether an ARBITRARY rule name
// read out of a directive is tracked, and a `Set<TrackedRule>` would reject
// that question at the type level instead of answering it.
const TRACKED_RULE_SET: ReadonlySet<string> = new Set(
  TRACKED_SUPPRESSION_RULES.map(({ rule }) => rule),
);

export const isTrackedRule = (rule: string): boolean =>
  TRACKED_RULE_SET.has(rule);

export const SECURITY_TIER_RULES = TRACKED_SUPPRESSION_RULES.filter(
  ({ tier }) => tier === "security",
).map(({ rule }) => rule);

const SECURITY_TIER_RULE_SET: ReadonlySet<string> = new Set(
  SECURITY_TIER_RULES,
);

export const isSecurityTierRule = (rule: string): boolean =>
  SECURITY_TIER_RULE_SET.has(rule);

// Ratchet metric ID for a tracked rule. Single-rule plugins repeat their name
// (`require-query-limit/require-query-limit`), so collapse the repetition
// rather than emit `require-query-limit-require-query-limit-suppressions`.
export const suppressionMetricId = (rule: string): string => {
  const parts = rule.split("/");
  const plugin = parts.at(0) ?? panic(`tracked rule ${rule} has no plugin`);
  const name = parts.at(1) ?? panic(`tracked rule ${rule} has no rule name`);
  const slug = plugin === name ? plugin : `${plugin}-${name}`;
  return `${slug}-suppressions`;
};

// --- Directive scanning -----------------------------------------------------

// A disable directive for ANY rule (either linter, any variant, `//` or `/*`
// comment form). Anchored at the comment start so a directive quoted inside
// prose ("removing the last eslint-disable is the goal") is not a directive.
const LINT_DISABLE_DIRECTIVE =
  /^(?:\/\/|\/\*)\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?\b/u;

export type LintDirective = {
  readonly text: string;
  // Byte offsets into the file, used to resolve the anchor symbol. Never a
  // ledger key: offsets and line numbers both move on every edit above them.
  readonly pos: number;
  readonly end: number;
  // Rules the directive names. EMPTY means a bare directive, which applies to
  // every rule — callers must treat it as suppressing all of them.
  readonly rules: readonly string[];
};

const parseSource = (content: string, file: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

// The rules a directive names, or `[]` for a bare directive. The rule list
// ends at the `--` reason trailer or the block-comment close, whichever comes
// first.
const directiveRules = (directive: string): readonly string[] => {
  const match = LINT_DISABLE_DIRECTIVE.exec(directive);
  if (!match) {
    return [];
  }

  const remainder = directive.slice(match.index + match[0].length);
  const boundaries = [remainder.indexOf("--"), remainder.indexOf("*/")].filter(
    (index) => index >= 0,
  );
  const ruleList = remainder
    .slice(0, boundaries.length > 0 ? Math.min(...boundaries) : undefined)
    .trim();
  if (ruleList.length === 0) {
    return [];
  }
  return ruleList.split(/[\s,]+/u).filter(Boolean);
};

const scanDirectives = (
  content: string,
  file: string,
): readonly LintDirective[] => {
  const source = parseSource(content, file);
  const comments = new Map<string, ts.CommentRange>();
  const collect = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      comments.set(`${range.pos}:${range.end}`, range);
    }
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(content, node.pos));
    collect(ts.getTrailingCommentRanges(content, node.end));
    for (const child of node.getChildren(source)) {
      visit(child);
    }
  };
  visit(source);

  const directives: LintDirective[] = [];
  for (const { pos, end } of [...comments.values()].sort(
    (left, right) => left.pos - right.pos,
  )) {
    const text = content.slice(pos, end);
    if (!LINT_DISABLE_DIRECTIVE.test(text)) {
      continue;
    }
    directives.push({ text, pos, end, rules: directiveRules(text) });
  }
  return directives;
};

// Parsing every file once per metric would multiply the TypeScript parse cost
// by the number of per-rule budgets. Memoize on (path, exact content) so a
// whole ratchet run parses each file once, and a temp-root self-test cannot
// read a stale entry for a path it reuses.
const directiveCache = new Map<
  string,
  { content: string; directives: readonly LintDirective[] }
>();

// Cheap necessary condition for a directive, checked before parsing. A file
// with no `-disable` token anywhere cannot contain one, and the vast majority
// of files do not — this keeps a repo-wide scan off the TypeScript parser for
// all but a few hundred files.
const DISABLE_TOKEN = /(?:eslint|oxlint)-disable/u;

export const collectLintDirectives = (
  content: string,
  file: string,
): readonly LintDirective[] => {
  if (!DISABLE_TOKEN.test(content)) {
    return [];
  }
  const cached = directiveCache.get(file);
  if (cached?.content === content) {
    return cached.directives;
  }
  const directives = scanDirectives(content, file);
  directiveCache.set(file, { content, directives });
  return directives;
};

// A bare directive names no rule, so it silences every rule — including every
// tracked one.
export const suppressesRule = (
  directive: LintDirective,
  rule: string,
): boolean => directive.rules.length === 0 || directive.rules.includes(rule);

// True when the directive belongs to the residual budget: it names at least
// one rule and none of them has a dedicated budget.
export const isResidualDirective = (directive: LintDirective): boolean =>
  directive.rules.length > 0 && !directive.rules.some(isTrackedRule);

// The `-- <reason>` trailer, or "" when the rationale lives in the comment
// above instead (both forms satisfy suppression-hygiene/require-description).
export const directiveReason = (directive: LintDirective): string => {
  const trailer = directive.text.indexOf("--");
  if (trailer === -1) {
    return "";
  }
  return directive.text
    .slice(trailer + 2)
    .replace(/\*\/\s*$/u, "")
    .trim();
};

// --- Anchor resolution ------------------------------------------------------

// The ledger keys entries by the nearest stable symbol, never by line number.
// TypeScript statement ranges include leading trivia, so the module-scope
// statements tile the file with no gaps: every directive resolves to exactly
// one of them, and edits inside a neighbouring function never move the key.
// Deliberately the OUTERMOST enclosing declaration rather than the innermost:
// a waiver's key must survive renaming a local, extracting a helper, or
// reordering statements inside the function that owns it.
const MODULE_ANCHOR = "<module>";

// Statement kinds that carry a name worth keying a waiver on. Import
// declarations are named by their module specifier rather than their bindings,
// so adding or removing an imported symbol does not rekey the entry.
const declarationName = (
  statement: ts.Statement,
  directivePos: number,
): string | null => {
  if (ts.isVariableStatement(statement)) {
    // `const a = ..., b = () => { ... }` is one statement with two names. Key
    // on the declarator the directive actually sits in, or two suppressions in
    // the same statement would collapse onto one waiver identity.
    const { declarations } = statement.declarationList;
    const containing = declarations.find(
      (declaration) =>
        declaration.pos <= directivePos && directivePos < declaration.end,
    );
    const declarator = containing ?? declarations.at(0);
    return declarator && ts.isIdentifier(declarator.name)
      ? declarator.name.text
      : null;
  }
  if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
    return statement.name.text;
  }
  if (ts.isImportDeclaration(statement)) {
    return ts.isStringLiteral(statement.moduleSpecifier)
      ? `import ${statement.moduleSpecifier.text}`
      : null;
  }
  if (ts.isExportAssignment(statement)) {
    return "export default";
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    const { name } = statement;
    return name && ts.isIdentifier(name) ? name.text : null;
  }
  return null;
};

// A statement with no usable name (a bare expression, an `export {}` list)
// anchors to the module itself. The key stays total, never absent.
const anchorNameFor = (statement: ts.Statement, directivePos: number): string =>
  declarationName(statement, directivePos) ?? MODULE_ANCHOR;

export const resolveDirectiveAnchors = (
  content: string,
  file: string,
  directives: readonly LintDirective[],
): readonly string[] => {
  const source = parseSource(content, file);
  const lineOf = (pos: number): number =>
    source.getLineAndCharacterOfPosition(pos).line;

  const statements = source.statements.map((statement) => ({
    statement,
    pos: statement.pos,
    end: statement.end,
    startLine: lineOf(statement.getStart(source)),
    endLine: lineOf(statement.end),
  }));

  return directives.map(({ pos }) => {
    // A trailing `-disable-line` directive sits after its statement's
    // semicolon, which is already the NEXT statement's leading trivia. Match
    // on code lines first so it anchors to the statement it actually
    // suppresses rather than the one that happens to follow.
    const line = lineOf(pos);
    const onCodeLine = statements.find(
      (statement) => statement.startLine <= line && line <= statement.endLine,
    );
    if (onCodeLine) {
      return anchorNameFor(onCodeLine.statement, pos);
    }
    // Otherwise the directive stands on its own line. Trivia-inclusive
    // statement ranges tile the file, so it belongs to the statement it
    // precedes — the `-next-line` case.
    const owner = statements.find(
      (statement) => statement.pos <= pos && pos < statement.end,
    );
    return owner ? anchorNameFor(owner.statement, pos) : MODULE_ANCHOR;
  });
};
