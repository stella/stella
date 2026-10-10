// A template fill's completion comes from one decision over one record.
//
// `apps/api/src/lib/templates/template-fill-completion.ts` owns the
// `FillDiagnostics` record (every outcome a fill reports about where the
// document differs from what was asked) and `decideTemplateFillCompletion`,
// the only reader that turns it into a verdict. A diagnostic a callee
// produces but the verdict never reads lets a fill report `success` with
// content missing. These rules keep every producer and consumer on that path:
//
// `fill-consumer-reads-decision`: a module that runs a fill (imports an entry
//   point of `template-fill-service`) also calls `decideTemplateFillCompletion`
//   or `templateFillStatus` (or records the fill through `recordTemplateFill`,
//   which writes that status); the raw producers the service composes
//   (`fillTemplate`, `resolveAiFields`, `resolveAiConditions`, `adaptAiFields`)
//   are imported by the service only.
// `no-raw-diagnostic-decision`: outside the owner, a diagnostic kind
//   (`aiFieldErrors`, `unmatchedPlaceholders`, ...) is not turned into a
//   decision: compared, negated or tested. Testing a kind only to present that
//   same kind (`x.length > 0 ? x : null`, a warning listing it) is presentation,
//   not a verdict, and stays allowed.
// `fill-status-literal-in-owner`: in a module that reads fill results, the
//   fill status literals (`success`, `partial`, `complete`, ...) are not
//   written into a status or completion slot; they come from the owner. A
//   conditional that restates an owner reading one to one
//   (`completion.type === "complete" ? "complete" : "partial"`) is the
//   owner's word, not a new one.
// `no-diagnostic-channel-outside-record`: in the fill pipeline, a new
//   `*Warnings` / `*Errors` / `*Failures` / `*Issues` / `*Diagnostics` key is a
//   diagnostic channel; it becomes a `FillDiagnostics` kind, graded in
//   `FILL_DIAGNOSTIC_GRADES`, instead of travelling beside the record.
// `fill-row-through-recorder`: `template_fills` rows (the recorded status) are
//   written by `recordTemplateFill` in `lib/templates/record-use.ts` only.
//
// Existing sites are budgeted per file, enclosing function and spelling in
// scripts/fill-diagnostics-ledger.json (no line numbers, a reason per row). A
// budget only shrinks: a hit beyond it fails, and so does a budget the code no
// longer reaches. Regenerate with `bun scripts/fill-diagnostics-ledger.ts
// --write`.

import type { Context, ESTree } from "@oxlint/plugins";
import { eslintCompatPlugin } from "@oxlint/plugins";

import ledger from "../scripts/fill-diagnostics-ledger.json" with { type: "json" };
import {
  createBudgetLedger,
  enclosingScopeName,
  FUNCTION_TYPES,
  type BudgetTracker,
} from "./budget-ledger.ts";
import {
  filenameForContext,
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  memberPropertyName,
  TRANSPARENT_WRAPPERS,
  unwrapExpression,
  type AstNode,
} from "./utils.ts";

const LEDGER_PATH = "scripts/fill-diagnostics-ledger.json";

const OWNER = "apps/api/src/lib/templates/template-fill-completion.ts";
const SERVICE = "apps/api/src/lib/templates/template-fill-service.ts";
const RECORDER = "apps/api/src/lib/templates/record-use.ts";

/** The kinds of the `FillDiagnostics` record (`FILL_DIAGNOSTIC_KINDS`; the
 *  rule tests fail when the two differ). */
export const RECORD_KINDS: readonly string[] = [
  "unmatchedPlaceholders",
  "aiFieldErrors",
  "undecidedConditions",
  "clauseWarnings",
  "structureErrors",
  "unusedValues",
  "unrestoredFields",
];

/** The record kinds plus the service's raw condition outcomes the record's
 *  `undecidedConditions` is read from. */
export const DIAGNOSTIC_KINDS: ReadonlySet<string> = new Set([
  ...RECORD_KINDS,
  "conditionDecisions",
]);

/** The template fill service's entry points: running one is a fill. */
const FILL_ENTRY_POINTS: ReadonlySet<string> = new Set([
  "fillTemplateDocx",
  "fillTemplateDocxStrict",
  "fillStoredTemplateDocx",
  "fillStoredTemplateWithText",
  "fillStoredTemplateWithTextStrict",
  "fillStoredTemplate",
]);

/** The producers the service composes, by the module that exports each. */
const RAW_PRODUCERS: ReadonlyMap<string, string> = new Map([
  ["fillTemplate", "patch-template"],
  ["resolveAiFields", "resolve-ai-fields"],
  ["resolveAiConditions", "resolve-ai-conditions"],
  ["adaptAiFields", "adapt-ai-fields"],
]);

/** The readers of the decision. `recordTemplateFill` records the owner's
 *  `templateFillStatus` as the fill row's status. */
const DECISION_READERS: ReadonlySet<string> = new Set([
  "decideTemplateFillCompletion",
  "templateFillStatus",
  "recordTemplateFill",
]);

/**
 * The status words a branch may write when it maps an owner reading one to
 * one, by the reader and the value it is compared with: `completion.type ===
 * "complete" ? "complete" : "partial"` restates the decision, and so does
 * `templateFillStatus(d) === "success" ? "complete" : "partial"`. Keyed by
 * the compared value: the branch that matches it writes `matched`, the other
 * branch `other`. A decision that is not `complete` is `partial` or
 * `rejected_partial`, so only `complete` is compared on the decision's type.
 */
const DECISION_STATUS_MAPS: ReadonlyMap<
  string,
  {
    member: string | null;
    words: ReadonlyMap<string, { matched: string; other: string }>;
  }
> = new Map([
  [
    "decideTemplateFillCompletion",
    {
      member: "type",
      words: new Map([["complete", { matched: "complete", other: "partial" }]]),
    },
  ],
  [
    "templateFillStatus",
    {
      member: null,
      words: new Map([
        ["success", { matched: "complete", other: "partial" }],
        ["partial", { matched: "partial", other: "complete" }],
      ]),
    },
  ],
]);

const STATUS_LITERALS: ReadonlySet<string> = new Set([
  "success",
  "partial",
  "complete",
  "incomplete",
]);

const STATUS_SLOT = /status|completion|complete/iu;

const CHANNEL_KEY =
  /^[a-z][A-Za-z0-9]*(?:Warnings|Errors|Failures|Issues|Diagnostics)$/u;

const COMPARISON_OPERATORS: ReadonlySet<string> = new Set([
  "==",
  "!=",
  "===",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
]);

// --- Ledger ------------------------------------------------------------------

const { tracker: budgetTracker, staleMessage: STALE_MESSAGE } =
  createBudgetLedger(LEDGER_PATH, ledger);

const isFile = (filename: string, file: string): boolean =>
  filename === file || filename.endsWith(`/${file}`);

// --- Shapes ------------------------------------------------------------------

const moduleBasename = (source: unknown): string | null => {
  if (!isAstNode(source) || typeof source.value !== "string") {
    return null;
  }
  const base = source.value.split("/").at(-1) ?? "";
  return base.replace(/\.[cm]?[jt]sx?$/u, "");
};

const isTypeOnly = (node: AstNode): boolean => node.importKind === "type";

/** The value import specifiers of `declaration`, with their imported names. */
const valueSpecifiers = (
  declaration: AstNode,
): { specifier: AstNode; name: string }[] => {
  if (isTypeOnly(declaration) || !Array.isArray(declaration.specifiers)) {
    return [];
  }
  return declaration.specifiers.flatMap((specifier: unknown) => {
    if (!isAstNode(specifier) || isTypeOnly(specifier)) {
      return [];
    }
    const name = getImportedName(specifier);
    return name === null ? [] : [{ specifier, name }];
  });
};

const calleeName = (call: AstNode): string | null => {
  const callee = unwrapExpression(call.callee);
  if (isIdentifier(callee)) {
    return callee.name;
  }
  return callee?.type === "MemberExpression"
    ? memberPropertyName(callee)
    : null;
};

/** The kind a member read or bare identifier names, if it names one. */
const kindRead = (node: AstNode): { read: AstNode; kind: string } | null => {
  if (node.type !== "MemberExpression") {
    return null;
  }
  const property = memberPropertyName(node);
  if (property !== null && DIAGNOSTIC_KINDS.has(property)) {
    return { read: node, kind: property };
  }
  const object = unwrapExpression(node.object);
  if (isIdentifier(object) && DIAGNOSTIC_KINDS.has(object.name)) {
    return { read: object, kind: object.name };
  }
  return null;
};

/** Every kind read inside `node`. */
const kindsReadIn = (node: unknown, found: Set<string>): Set<string> => {
  if (!isAstNode(node)) {
    return found;
  }
  if (node.type === "MemberExpression") {
    const read = kindRead(node);
    if (read !== null) {
      found.add(read.kind);
    }
  } else if (isIdentifier(node) && DIAGNOSTIC_KINDS.has(node.name)) {
    found.add(node.name);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        kindsReadIn(item, found);
      }
    } else if (isAstNode(value)) {
      kindsReadIn(value, found);
    }
  }
  return found;
};

/** A branch that carries nothing: no branch, `null`, `undefined`, `{}`,
 *  `[]`, `false`, or an empty block. */
const isEmptyBranch = (node: unknown): boolean => {
  const branch = unwrapExpression(node);
  if (branch === null) {
    return true;
  }
  switch (branch.type) {
    case "Literal":
      return branch.value === null || branch.value === false;
    case "Identifier":
      return branch.name === "undefined";
    case "ObjectExpression":
      return Array.isArray(branch.properties) && branch.properties.length === 0;
    case "ArrayExpression":
      return Array.isArray(branch.elements) && branch.elements.length === 0;
    case "BlockStatement":
      return Array.isArray(branch.body) && branch.body.length === 0;
    default:
      return false;
  }
};

/** `base` in `x.length === 0 ? base : { ...base, x }`: a branch that passes on
 *  the value another branch spreads and extends carries nothing of its own. */
const isPassthroughBranch = (
  branch: unknown,
  branches: readonly unknown[],
): boolean => {
  const base = unwrapExpression(branch);
  if (!isIdentifier(base)) {
    return false;
  }
  return branches.some((other) => {
    const object = unwrapExpression(other);
    return (
      object?.type === "ObjectExpression" &&
      Array.isArray(object.properties) &&
      object.properties.some((property: unknown) => {
        if (!isAstNode(property) || property.type !== "SpreadElement") {
          return false;
        }
        const spread = unwrapExpression(property.argument);
        return isIdentifier(spread) && spread.name === base.name;
      })
    );
  });
};

/** Whether `node` writes a fill status literal anywhere inside it. */
const containsStatusLiteral = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (
    node.type === "Literal" &&
    typeof node.value === "string" &&
    STATUS_LITERALS.has(node.value)
  ) {
    return true;
  }
  return Object.entries(node).some(([key, value]) => {
    if (key === "parent") {
      return false;
    }
    return Array.isArray(value)
      ? value.some((item) => containsStatusLiteral(item))
      : containsStatusLiteral(value);
  });
};

/**
 * Whether a test on `kind` only gates the presentation of that same kind:
 * every guarded branch is empty or reads `kind` and no other kind, and none
 * writes a status. `x.length > 0 ? x : null` and "warn, listing x" are
 * presentation; "x is empty, so the fill succeeded" is a verdict.
 */
const presentsOnlyItself = (
  test: AstNode,
  kind: string,
  branches: readonly unknown[],
): boolean => {
  const tested = kindsReadIn(test, new Set());
  if (tested.size !== 1 || !tested.has(kind)) {
    return false;
  }
  let presented = false;
  for (const branch of branches) {
    if (isEmptyBranch(branch) || isPassthroughBranch(branch, branches)) {
      continue;
    }
    const read = kindsReadIn(branch, new Set());
    if (read.size !== 1 || !read.has(kind) || containsStatusLiteral(branch)) {
      return false;
    }
    presented = true;
  }
  return presented;
};

/**
 * Whether the kind read at `read` becomes a decision: it is compared, negated
 * or tested, and the test does not merely present the same kind.
 */
const isDecisionRead = (read: AstNode, kind: string): boolean => {
  let current: AstNode = read;
  let decided = false;
  for (;;) {
    const parent = isAstNode(current.parent) ? current.parent : null;
    if (parent === null) {
      return decided;
    }
    if (TRANSPARENT_WRAPPERS.has(parent.type)) {
      current = parent;
      continue;
    }
    switch (parent.type) {
      case "MemberExpression":
        if (parent.object !== current) {
          return decided;
        }
        current = parent;
        continue;
      case "CallExpression":
        current = parent;
        continue;
      case "BinaryExpression":
        if (
          typeof parent.operator === "string" &&
          COMPARISON_OPERATORS.has(parent.operator)
        ) {
          decided = true;
        }
        current = parent;
        continue;
      case "UnaryExpression":
        if (parent.operator === "!") {
          decided = true;
        }
        current = parent;
        continue;
      case "LogicalExpression":
        if (parent.left === current) {
          return !presentsOnlyItself(current, kind, [parent.right]);
        }
        current = parent;
        continue;
      case "ConditionalExpression":
        if (parent.test === current) {
          return !presentsOnlyItself(current, kind, [
            parent.consequent,
            parent.alternate,
          ]);
        }
        return decided;
      case "IfStatement":
        if (parent.test === current) {
          return !presentsOnlyItself(current, kind, [
            parent.consequent,
            parent.alternate,
          ]);
        }
        return decided;
      case "WhileStatement":
      case "DoWhileStatement":
      case "ForStatement":
        return parent.test === current || decided;
      case "SwitchStatement":
        return parent.discriminant === current || decided;
      default:
        return decided;
    }
  }
};

/** The slot a status literal is written into: a property, variable or
 *  assignment target named like a status, or the return of such a function. */
const statusSlot = (literal: AstNode): string | null => {
  let current: AstNode = literal;
  for (;;) {
    const parent = isAstNode(current.parent) ? current.parent : null;
    if (parent === null) {
      return null;
    }
    if (
      TRANSPARENT_WRAPPERS.has(parent.type) ||
      (parent.type === "ConditionalExpression" && parent.test !== current) ||
      (parent.type === "LogicalExpression" && parent.right === current)
    ) {
      current = parent;
      continue;
    }
    if (parent.type === "Property" && parent.value === current) {
      const key = parent.computed === true ? null : getPropertyName(parent.key);
      return key !== null && STATUS_SLOT.test(key) ? key : null;
    }
    if (parent.type === "VariableDeclarator" && parent.init === current) {
      return isIdentifier(parent.id) && STATUS_SLOT.test(parent.id.name)
        ? parent.id.name
        : null;
    }
    if (parent.type === "AssignmentExpression" && parent.right === current) {
      const left = unwrapExpression(parent.left);
      const name = isIdentifier(left)
        ? left.name
        : left?.type === "MemberExpression"
          ? memberPropertyName(left)
          : null;
      return name !== null && STATUS_SLOT.test(name) ? name : null;
    }
    if (
      parent.type === "ReturnStatement" ||
      (parent.type === "ArrowFunctionExpression" && parent.body === current)
    ) {
      const scope = enclosingScopeName(current);
      return STATUS_SLOT.test(scope) ? scope : null;
    }
    return null;
  }
};

/** A binding initialised from an owner reading (`const completion =
 *  decideTemplateFillCompletion(...)`), with the reader that produced it. */
type ReaderBinding = { declarator: AstNode; reader: string };

/** The reader a declarator's initialiser calls, if it is a mapped reader. */
const readerOfDeclarator = (declarator: AstNode): string | null => {
  if (!isIdentifier(declarator.id)) {
    return null;
  }
  let init = unwrapExpression(declarator.init);
  if (init?.type === "AwaitExpression") {
    init = unwrapExpression(init.argument);
  }
  if (init?.type !== "CallExpression") {
    return null;
  }
  const name = calleeName(init);
  return name !== null && DECISION_STATUS_MAPS.has(name) ? name : null;
};

const nearestFunction = (node: AstNode): AstNode | null => {
  let current: unknown = node.parent;
  while (isAstNode(current)) {
    if (FUNCTION_TYPES.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
};

const isAncestorOf = (ancestor: AstNode, node: AstNode): boolean => {
  let current: unknown = node.parent;
  while (isAstNode(current)) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

/** The conditional a status literal is a branch of, through wrappers and the
 *  object property it fills (`cond ? { status: "x" } : ...`). */
const enclosingBranch = (
  literal: AstNode,
): { conditional: AstNode; consequent: boolean } | null => {
  let current: AstNode = literal;
  for (;;) {
    const parent = isAstNode(current.parent) ? current.parent : null;
    if (parent === null) {
      return null;
    }
    if (
      TRANSPARENT_WRAPPERS.has(parent.type) ||
      (parent.type === "Property" && parent.value === current) ||
      parent.type === "ObjectExpression"
    ) {
      current = parent;
      continue;
    }
    if (parent.type === "ConditionalExpression" && parent.test !== current) {
      return { conditional: parent, consequent: parent.consequent === current };
    }
    return null;
  }
};

/**
 * Whether a status literal restates an owner reading one to one (see
 * {@link DECISION_STATUS_MAPS}): it is a branch of a conditional that
 * compares a binding of that reading with one of the mapped values, and it
 * writes the word the map gives that branch.
 */
const mapsOwnerReading = (
  literal: AstNode,
  bindings: ReadonlyMap<string, readonly ReaderBinding[]>,
): boolean => {
  const branch = enclosingBranch(literal);
  const test = unwrapExpression(branch?.conditional.test);
  if (
    branch === null ||
    test?.type !== "BinaryExpression" ||
    (test.operator !== "===" && test.operator !== "!==")
  ) {
    return false;
  }
  const left = unwrapExpression(test.left);
  const right = unwrapExpression(test.right);
  const [compared, read] =
    left?.type === "Literal" ? [left, right] : [right, left];
  if (compared?.type !== "Literal" || typeof compared.value !== "string") {
    return false;
  }
  const member = read?.type === "MemberExpression" ? read : null;
  const subject = member === null ? read : unwrapExpression(member.object);
  if (!isIdentifier(subject)) {
    return false;
  }
  const memberName = member === null ? null : memberPropertyName(member);
  return (bindings.get(subject.name) ?? []).some(({ declarator, reader }) => {
    const map = DECISION_STATUS_MAPS.get(reader);
    const scope = nearestFunction(declarator);
    if (
      map === undefined ||
      map.member !== memberName ||
      (scope !== null && !isAncestorOf(scope, branch.conditional))
    ) {
      return false;
    }
    const words = map.words.get(String(compared.value));
    if (words === undefined) {
      return false;
    }
    const matchesBranch = branch.consequent === (test.operator === "===");
    return literal.value === (matchesBranch ? words.matched : words.other);
  });
};

const isInsideObjectPattern = (node: AstNode): boolean =>
  isAstNode(node.parent) && node.parent.type === "ObjectPattern";

// --- Rules -------------------------------------------------------------------

const reportWith =
  (context: Context, tracker: BudgetTracker) =>
  (node: AstNode, pattern: string, messageId: string) => {
    const report = tracker.record(node, pattern, messageId);
    if (report !== null) {
      context.report({ node, ...report });
    }
  };

const reportStale = (
  context: Context,
  tracker: BudgetTracker,
  node: ESTree.Node,
) => {
  for (const report of tracker.stale()) {
    context.report({ node, ...report });
  }
};

export default eslintCompatPlugin({
  meta: { name: "fill-diagnostics" },
  rules: {
    "fill-consumer-reads-decision": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          noDecision:
            "This module runs a template fill (`{{pattern}}`) but never reads its completion decision: report the fill's status from `decideTemplateFillCompletion` or `templateFillStatus` (lib/templates/template-fill-completion.ts). Ledger key: {{key}}",
          rawProducer:
            "`{{pattern}}` produces fill diagnostics the completion decision only sees through the template fill service: run the fill through lib/templates/template-fill-service.ts. Ledger key: {{key}}",
          stale: STALE_MESSAGE,
        },
      },
      createOnce(context) {
        const tracker = budgetTracker("fill-consumer-reads-decision");
        const report = reportWith(context, tracker);
        let exempt = false;
        let readsDecision = false;
        let entryImports: { specifier: AstNode; name: string }[] = [];
        return {
          before() {
            const filename = filenameForContext(context);
            tracker.reset(filename);
            exempt = isFile(filename, SERVICE) || isFile(filename, OWNER);
            readsDecision = false;
            entryImports = [];
          },
          ImportDeclaration(node) {
            if (exempt || !isAstNode(node)) {
              return;
            }
            const base = moduleBasename(node.source);
            for (const imported of valueSpecifiers(node)) {
              if (
                base === "template-fill-service" &&
                FILL_ENTRY_POINTS.has(imported.name)
              ) {
                entryImports.push(imported);
              }
              if (base !== null && RAW_PRODUCERS.get(imported.name) === base) {
                report(
                  imported.specifier,
                  `raw:${imported.name}`,
                  "rawProducer",
                );
              }
            }
          },
          CallExpression(node) {
            if (!isAstNode(node)) {
              return;
            }
            const name = calleeName(node);
            if (name !== null && DECISION_READERS.has(name)) {
              readsDecision = true;
            }
          },
          "Program:exit"(node) {
            if (!readsDecision) {
              for (const imported of entryImports) {
                report(
                  imported.specifier,
                  `entry:${imported.name}`,
                  "noDecision",
                );
              }
            }
            reportStale(context, tracker, node);
          },
        };
      },
    },
    "no-raw-diagnostic-decision": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          rawDecision:
            "`{{pattern}}` is a fill diagnostic: decide on the fill through `decideTemplateFillCompletion` (lib/templates/template-fill-completion.ts) instead of testing one kind. Ledger key: {{key}}",
          stale: STALE_MESSAGE,
        },
      },
      createOnce(context) {
        const tracker = budgetTracker("no-raw-diagnostic-decision");
        const report = reportWith(context, tracker);
        let exempt = false;
        return {
          before() {
            const filename = filenameForContext(context);
            tracker.reset(filename);
            exempt = isFile(filename, OWNER);
          },
          MemberExpression(node) {
            if (exempt || !isAstNode(node)) {
              return;
            }
            // A member read (`filled.aiFieldErrors`) is its own node; a bare
            // binding (`aiFieldErrors.length`) is reached through its member.
            const read = kindRead(node);
            if (read !== null && isDecisionRead(read.read, read.kind)) {
              report(read.read, read.kind, "rawDecision");
            }
          },
          IfStatement(node) {
            if (exempt || !isAstNode(node)) {
              return;
            }
            // `if (aiFieldErrors)` tests a bare kind with no member access.
            const test = unwrapExpression(node.test);
            if (
              isIdentifier(test) &&
              DIAGNOSTIC_KINDS.has(test.name) &&
              isDecisionRead(test, test.name)
            ) {
              report(test, test.name, "rawDecision");
            }
          },
          "Program:exit"(node) {
            reportStale(context, tracker, node);
          },
        };
      },
    },
    "fill-status-literal-in-owner": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          statusLiteral:
            "Fill status `{{pattern}}` is written outside its owner: take the status from `decideTemplateFillCompletion` / `templateFillStatus` (lib/templates/template-fill-completion.ts). Ledger key: {{key}}",
          stale: STALE_MESSAGE,
        },
      },
      createOnce(context) {
        const tracker = budgetTracker("fill-status-literal-in-owner");
        const report = reportWith(context, tracker);
        let exempt = false;
        let readsFills = false;
        let candidates: AstNode[] = [];
        let readerBindings = new Map<string, ReaderBinding[]>();
        return {
          before() {
            const filename = filenameForContext(context);
            tracker.reset(filename);
            exempt = isFile(filename, OWNER);
            readsFills = false;
            candidates = [];
            readerBindings = new Map();
          },
          ImportDeclaration(node) {
            if (!isAstNode(node)) {
              return;
            }
            const base = moduleBasename(node.source);
            if (
              base === "template-fill-service" ||
              base === "template-fill-completion"
            ) {
              readsFills = true;
            }
          },
          Literal(node) {
            if (
              !exempt &&
              isAstNode(node) &&
              typeof node.value === "string" &&
              STATUS_LITERALS.has(node.value)
            ) {
              candidates.push(node);
            }
          },
          VariableDeclarator(node) {
            if (exempt || !isAstNode(node)) {
              return;
            }
            const reader = readerOfDeclarator(node);
            if (reader !== null && isIdentifier(node.id)) {
              const list = readerBindings.get(node.id.name) ?? [];
              list.push({ declarator: node, reader });
              readerBindings.set(node.id.name, list);
            }
          },
          "Program:exit"(node) {
            if (readsFills) {
              for (const literal of candidates) {
                if (
                  statusSlot(literal) !== null &&
                  !mapsOwnerReading(literal, readerBindings)
                ) {
                  report(literal, String(literal.value), "statusLiteral");
                }
              }
            }
            reportStale(context, tracker, node);
          },
        };
      },
    },
    "no-diagnostic-channel-outside-record": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          channel:
            "`{{pattern}}` is a fill diagnostic channel outside the `FillDiagnostics` record: add it as a kind there and grade it in `FILL_DIAGNOSTIC_GRADES` (lib/templates/template-fill-completion.ts) so the completion decision reads it. Ledger key: {{key}}",
          stale: STALE_MESSAGE,
        },
      },
      createOnce(context) {
        const tracker = budgetTracker("no-diagnostic-channel-outside-record");
        const report = reportWith(context, tracker);
        let exempt = false;
        const check = (node: unknown) => {
          if (exempt || !isAstNode(node) || node.computed === true) {
            return;
          }
          const key = getPropertyName(node.key);
          if (
            key !== null &&
            CHANNEL_KEY.test(key) &&
            !DIAGNOSTIC_KINDS.has(key) &&
            !isInsideObjectPattern(node)
          ) {
            report(node, key, "channel");
          }
        };
        return {
          before() {
            const filename = filenameForContext(context);
            tracker.reset(filename);
            exempt = isFile(filename, OWNER);
          },
          Property: check,
          TSPropertySignature: check,
          PropertyDefinition: check,
          "Program:exit"(node) {
            reportStale(context, tracker, node);
          },
        };
      },
    },
    "fill-row-through-recorder": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          directRow:
            "Record a template fill through `recordTemplateFill` (lib/templates/record-use.ts), which writes the status from the completion decision. Ledger key: {{key}}",
          stale: STALE_MESSAGE,
        },
      },
      createOnce(context) {
        const tracker = budgetTracker("fill-row-through-recorder");
        const report = reportWith(context, tracker);
        let exempt = false;
        let tableNames = new Set<string>();
        return {
          before() {
            const filename = filenameForContext(context);
            tracker.reset(filename);
            exempt = isFile(filename, RECORDER);
            tableNames = new Set();
          },
          ImportDeclaration(node) {
            if (!isAstNode(node) || !Array.isArray(node.specifiers)) {
              return;
            }
            for (const imported of valueSpecifiers(node)) {
              const local = imported.specifier.local;
              if (imported.name === "templateFills" && isIdentifier(local)) {
                tableNames.add(local.name);
              }
            }
          },
          CallExpression(node) {
            if (exempt || !isAstNode(node) || calleeName(node) !== "insert") {
              return;
            }
            const callee = unwrapExpression(node.callee);
            const table = Array.isArray(node.arguments)
              ? unwrapExpression(node.arguments[0])
              : null;
            if (
              callee?.type === "MemberExpression" &&
              isIdentifier(table) &&
              tableNames.has(table.name)
            ) {
              report(node, "insert:templateFills", "directRow");
            }
          },
          "Program:exit"(node) {
            reportStale(context, tracker, node);
          },
        };
      },
    },
  },
});
