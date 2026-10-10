// Require an audit emission in every handler function that mutates the
// database, so a new write endpoint cannot land without leaving a
// SOC 2 / ISO 27001 audit trail.
//
// This is the dev-error layer; the recorder itself writes the audit row
// in the same transaction as the mutation (see audit-log.ts), so the
// audit row commits or rolls back atomically with the write. The lint
// rule catches "wrote DB, forgot audit" before it ships. Postgres-level
// triggers remain available as a defense-in-depth measure.
//
// Scope: apps/api/src/handlers/**, apps/api/src/mcp/** and
// apps/api/src/lib/** (tests excluded). Outside handlers the rule takes a
// `budgets` option, generated from require-audit-on-mutation-ledger.json by
// scripts/audit-mutation-ledger.ts: per `<file>::<owner>` (the dotted path of
// named enclosing functions) and per write target (`insert:entities`), the
// unaudited writes that existed when the scope was extended. Writes are
// budgeted by target, not by count, so trading one unaudited write for a
// different one is a new write. An owner over a target's budget reports every
// write it holds to that target; a target under its budget reports the stale
// row, so the ledger only shrinks. A file with no ledger row is held to the
// full rule.
//
// Flags (one report per mutation in an offending function):
//   await safeDb(async (tx) => {
//     await tx.insert(entities).values(...);
//     // ^^ no audit recorder call in this function
//   });
//
// Detected mutations:
//   - `<receiver>.insert(...)`, `.update(...)`, `.delete(...)` where the
//     receiver is a database handle: `tx` / `db` / `trx` or a camel-cased name
//     ending in `Tx` / `Db` (`innerTx`, `scopedDb`, not `ctx`), a member with
//     such a name (`ctx.db`), a `getDb()`-style call, or a parameter of a
//     `.transaction(...)` callback or typed as a transaction.
//   - `<receiver>.execute(sql`...`)` whose static SQL inserts, updates, or
//     deletes rows.
// (`isDatabaseWriteCall` in utils.ts owns this detection.)
//
// Allows:
//   - The function calls an audit recorder: the handler context's injected
//     recorder (`recordAuditEvent`, `ctx.recordAuditEvent`, a
//     `record*AuditEvent` parameter), a recorder built by the audit-log
//     factories, or an imported audited helper (`auditedPresignDownload`,
//     `recordWebhookAuditEvent`, `recordCorpusWithdrawalAuditEvent`,
//     `recordSystemAudit`). A locally defined function of the same name does
//     not count.
//   - The file is a system module: the `systemModules` option (generated from
//     SYSTEM_AUDIT_MODULES in apps/api/src/lib/system-audit/modules.ts) maps
//     it to a system run actor, whose run records one aggregated
//     `system_audit_runs` row through `recordSystemAudit`. A member-run module
//     (MEMBER_RUN_MODULES) or an unknown actor in that map is reported instead.
//     The system-audit recorder module itself writes the audit record.
//   - The function carries a `// audit: skip - <reason>` directive in its own
//     body, with a reason of at least three words. The `audit-skip-directives`
//     ratchet metric counts these directives so they can only shrink.
//   - A justified directive immediately above a mutation expression marks
//     that one call, including in an expression-bodied arrow.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Ranged, Variable } from "@oxlint/plugins";
import path from "node:path";

import { isSystemRunActor } from "../apps/api/src/lib/system-audit/actors.ts";
import { MEMBER_RUN_MODULES } from "../apps/api/src/lib/system-audit/modules.ts";
import {
  type AstNode,
  type ImportedFromOptions,
  databaseWriteTarget,
  filenameForContext,
  invokedCallee,
  isAstNode,
  isDatabaseWriteCall,
  isIdentifier,
  isIdentifierReference,
  isImportedFrom,
  memberPropertyName,
  patternKeyFor,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

type RuleContext = ImportedFromOptions["context"];

const AUDIT_RECORDER_NAME =
  /^(?:record[A-Z][A-Za-z0-9]*?AuditEvents?|recordAuditEvent)$/u;

// Imported helpers that write their own audit row.
const AUDITED_HELPERS = [
  {
    module: "apps/api/src/lib/db/audit-recording",
    names: new Set(["recordAuditGroups"]),
  },
  {
    module: "apps/api/src/lib/db/service-client-audit",
    names: new Set(["recordServiceClientOperatorAuditEvent"]),
  },
  {
    module: "apps/api/src/lib/audit-log",
    names: new Set(["recordAuditGroups"]),
  },
  {
    module: "apps/api/src/lib/audited-download",
    names: new Set(["auditedPresignDownload"]),
  },
  {
    module: "apps/api/src/lib/hosted-usage-provider/webhook-store",
    names: new Set(["recordWebhookAuditEvent"]),
  },
  {
    module: "apps/api/src/lib/legal-search/corpus-index-job-audit",
    names: new Set(["recordCorpusWithdrawalAuditEvent"]),
  },
  {
    module: "apps/api/src/lib/system-audit/record",
    names: new Set(["recordSystemAudit"]),
  },
] as const;
// The system-audit recorder: its one write is the audit record.
const SYSTEM_AUDIT_RECORDER_FILE = "apps/api/src/lib/system-audit/record.ts";
const MEMBER_RUN_MODULE_FILES: ReadonlySet<string> = new Set(
  MEMBER_RUN_MODULES,
);
const AUDIT_LOG_MODULES = [
  "apps/api/src/lib/audit-log",
  "apps/api/src/lib/db/audit-recording",
];
const AUDIT_RECORDER_FACTORIES: ReadonlySet<string> = new Set([
  "createAuditRecorder",
  "createBackgroundAuditRecorder",
]);
// Guards the identifier-to-initializer walks against cycles.
const MAX_RESOLVE_DEPTH = 4;

const SKIP_DIRECTIVE = /audit:\s*skip\b(?<reason>.*)$/isu;
const MIN_SKIP_REASON_WORDS = 3;
const CALL_DIRECTIVE_GAP = /^\r?\n[\t ]*(?:await[\t ]+)?$/u;

// Whether a comment is an `audit: skip - <reason>` directive with a reason of
// at least three words.
const isJustifiedSkipDirective = (text: string): boolean => {
  const reason = SKIP_DIRECTIVE.exec(text)?.groups?.reason ?? "";
  const words = reason.split(/\s+/u).filter((word) => /\p{L}/u.test(word));
  return words.length >= MIN_SKIP_REASON_WORDS;
};

const isAuditedHelperImport = (context: RuleContext, node: unknown): boolean =>
  AUDITED_HELPERS.some(({ module, names }) =>
    isImportedFrom({ context, node, modules: [module], names }),
  );

const isRecorderFactoryCall = (
  context: RuleContext,
  node: unknown,
): boolean => {
  const call = unwrapExpression(node);
  return (
    call?.type === "CallExpression" &&
    isImportedFrom({
      context,
      node: invokedCallee(call),
      modules: AUDIT_LOG_MODULES,
      names: AUDIT_RECORDER_FACTORIES,
    })
  );
};

// Whether a variable holds an audit recorder: an injected parameter, a
// binding destructured from an injected context, a recorder built by the
// audit-log factories, or an alias of one of those.
const isRecorderVariable = (
  context: RuleContext,
  variable: Variable,
  depth: number,
): boolean => {
  const definition = variable.defs.at(0);
  if (variable.defs.length !== 1 || definition === undefined) {
    return false;
  }
  if (definition.type === "Parameter") {
    return AUDIT_RECORDER_NAME.test(variable.name);
  }
  if (definition.type !== "Variable") {
    return false;
  }
  const declarator: unknown = definition.node;
  if (!isAstNode(declarator)) {
    return false;
  }
  if (isAstNode(declarator.id) && declarator.id.type === "ObjectPattern") {
    const key = patternKeyFor(declarator.id, definition.name);
    const source = unwrapExpression(declarator.init);
    return (
      key !== null &&
      AUDIT_RECORDER_NAME.test(key) &&
      source !== null &&
      source.type !== "ObjectExpression"
    );
  }
  const init = stableInitializer(variable);
  return init !== null && isRecorderExpression(context, init, depth + 1);
};

// Whether an expression evaluates to an audit recorder or audited helper.
const isRecorderExpression = (
  context: RuleContext,
  node: unknown,
  depth: number,
): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null || depth > MAX_RESOLVE_DEPTH) {
    return false;
  }
  if (isAuditedHelperImport(context, expression)) {
    return true;
  }
  if (resolveImport(context, expression) !== null) {
    return false;
  }
  if (isRecorderFactoryCall(context, expression)) {
    return true;
  }
  if (expression.type === "LogicalExpression") {
    return isRecorderExpression(context, expression.left, depth + 1);
  }
  if (expression.type === "MemberExpression") {
    const property = memberPropertyName(expression);
    return property !== null && AUDIT_RECORDER_NAME.test(property);
  }
  if (!isIdentifierReference(expression)) {
    return false;
  }
  const variable = resolveVariable(context, expression);
  return variable !== null && isRecorderVariable(context, variable, depth);
};

const isAuditCall = (context: RuleContext, node: unknown): boolean => {
  const call = unwrapExpression(node);
  return (
    call?.type === "CallExpression" &&
    isRecorderExpression(context, invokedCallee(call), 0)
  );
};

type Range = [number, number];

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const MEMBER_DEFINITION_TYPES: ReadonlySet<string> = new Set([
  "Property",
  "MethodDefinition",
  "PropertyDefinition",
]);

const keyName = (key: unknown): string | null => {
  if (isIdentifier(key)) {
    return key.name;
  }
  return isAstNode(key) &&
    key.type === "Literal" &&
    typeof key.value === "string"
    ? key.value
    : null;
};

// The name a function is reachable by in its file: its declaration name, the
// variable it initializes, or the object or class member it defines.
const ownFunctionName = (fn: AstNode): string | null => {
  if (fn.type === "FunctionDeclaration" && isIdentifier(fn.id)) {
    return fn.id.name;
  }
  const parent = isAstNode(fn.parent) ? fn.parent : null;
  if (parent === null) {
    return null;
  }
  if (parent.type === "VariableDeclarator" && parent.init === fn) {
    return isIdentifier(parent.id) ? parent.id.name : null;
  }
  return MEMBER_DEFINITION_TYPES.has(parent.type) && parent.value === fn
    ? keyName(parent.key)
    : null;
};

/**
 * The ledger key of a function: the dotted path of its named enclosing
 * functions, outermost first, so an anonymous transaction callback is
 * budgeted with the function that opens it and same-named callbacks
 * (`try`, `run`) in different functions stay apart. A key carries no line
 * number, so unrelated edits do not move it.
 */
const ownerName = (node: unknown): string => {
  const names: string[] = [];
  let current: AstNode | null = isAstNode(node) ? node : null;
  while (current !== null) {
    const name = FUNCTION_TYPES.has(current.type)
      ? ownFunctionName(current)
      : null;
    if (name !== null) {
      names.unshift(name);
    }
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return names.length === 0 ? "<module>" : names.join(".");
};

type TargetBudgets = ReadonlyMap<string, number>;

const targetBudgetsOf = (value: unknown): TargetBudgets =>
  typeof value === "object" && value !== null
    ? new Map(
        Object.entries(value).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === "number" && entry[1] > 0,
        ),
      )
    : new Map();

/**
 * `budgets` option: `<repo-relative file>::<owner>` to its unaudited writes
 * per target.
 */
const budgetsFromOptions = (
  options: unknown,
): ReadonlyMap<string, TargetBudgets> => {
  if (
    typeof options !== "object" ||
    options === null ||
    !("budgets" in options) ||
    typeof options.budgets !== "object" ||
    options.budgets === null
  ) {
    return new Map();
  }
  return new Map(
    Object.entries(options.budgets).flatMap(([owner, targets]) => {
      const budgets = targetBudgetsOf(targets);
      return budgets.size === 0 ? [] : [[owner, budgets] as const];
    }),
  );
};

/** `systemModules` option: `<repo-relative file>` to its system run actor. */
const systemModulesFromOptions = (
  options: unknown,
): ReadonlyMap<string, unknown> => {
  if (
    typeof options !== "object" ||
    options === null ||
    !("systemModules" in options) ||
    typeof options.systemModules !== "object" ||
    options.systemModules === null
  ) {
    return new Map();
  }
  return new Map(Object.entries(options.systemModules));
};

/** `census` option: report every unaudited write with its owner, ignoring budgets. */
const censusFromOptions = (options: unknown): boolean =>
  typeof options === "object" &&
  options !== null &&
  "census" in options &&
  options.census === true;

/** `root` option: what ledger paths are relative to (tests use a scratch root). */
const rootFromOptions = (options: unknown): string =>
  typeof options === "object" &&
  options !== null &&
  "root" in options &&
  typeof options.root === "string"
    ? options.root
    : REPOSITORY_ROOT;

type Mutation = { node: Ranged; target: string };

type FunctionScope = {
  owner: string;
  mutationNodes: Mutation[];
  hasAuditCall: boolean;
  bodyRange: Range | null;
  childBodyRanges: Range[];
};

const asRange = (value: unknown): Range | null => {
  if (!Array.isArray(value) || value.length !== 2) {
    return null;
  }
  const [start, end] = value;
  if (typeof start !== "number" || typeof end !== "number") {
    return null;
  }
  return [start, end];
};

const hasBodySkipDirective = (
  scope: FunctionScope,
  ranges: readonly Range[],
): boolean => {
  if (scope.bodyRange === null) {
    return false;
  }
  const [start, end] = scope.bodyRange;
  return ranges.some(
    ([commentStart]) =>
      commentStart >= start &&
      commentStart <= end &&
      !scope.childBodyRanges.some(
        ([childStart, childEnd]) =>
          commentStart >= childStart && commentStart <= childEnd,
      ),
  );
};

type CallSkipDirectiveOptions = {
  node: Ranged;
  source: string;
  ranges: readonly Range[];
};

const hasCallSkipDirective = ({
  node,
  source,
  ranges,
}: CallSkipDirectiveOptions): boolean => {
  const range = asRange(node.range);
  return (
    range !== null &&
    ranges.some(
      ([, end]) =>
        end < range[0] && CALL_DIRECTIVE_GAP.test(source.slice(end, range[0])),
    )
  );
};

export default eslintCompatPlugin({
  meta: { name: "require-audit-on-mutation" },
  rules: {
    "require-audit-on-mutation": {
      meta: {
        type: "problem",
        schema: [
          {
            type: "object",
            properties: {
              budgets: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  additionalProperties: { type: "integer", minimum: 1 },
                },
              },
              census: { type: "boolean" },
              root: { type: "string" },
              systemModules: {
                type: "object",
                additionalProperties: { type: "string" },
              },
            },
            additionalProperties: false,
          },
        ],
        messages: {
          missingAudit:
            "This function writes to the database (insert / update / " +
            "delete, or a raw write through execute) but does not call an " +
            "audit recorder. Add an audit emission in the same transaction, " +
            "or annotate the function with `// audit: skip - <reason>` (at " +
            "least three words) if the write legitimately needs no audit " +
            "row (presigned URL bookkeeping, scheduler runs, ephemeral state).",
          overBudget:
            "{{owner}} holds {{actual}} unaudited {{target}} writes; the " +
            "audit ledger allows {{budget}}. Add an audit emission in the " +
            "same transaction (or `// audit: skip - <reason>`); the ledger " +
            "only shrinks.",
          memberRunSystemModule:
            "{{file}} runs on behalf of a member, so it cannot be a system " +
            "module: remove it from SYSTEM_AUDIT_MODULES and audit its writes " +
            "through the member's actor.",
          unknownSystemActor:
            "{{file}} is registered to {{actor}}, which is not a system run " +
            "actor (SYSTEM_RUN_ACTOR_COUNTS).",
          staleBudget:
            "The audit ledger allows {{budget}} unaudited {{target}} writes " +
            "for {{owner}} but {{actual}} remain. Lower the row with " +
            "`bun scripts/audit-mutation-ledger.ts --write`.",
        },
      },
      createOnce(context) {
        const scopes: FunctionScope[] = [];
        // Ledger state for the current file: its budgets (empty outside the
        // ledger) and its unaudited writes grouped by owner.
        let fileBudgets = new Map<string, TargetBudgets>();
        // `census: true` (the ledger generator) groups every file by owner.
        let census = false;
        // A registered system module, or the system-audit recorder: its
        // writes are recorded by its actor's run, not per function.
        let systemFile = false;
        const isBudgeted = () => census || fileBudgets.size > 0;
        const unauditedByOwner = new Map<string, Mutation[]>();
        // Justified directives are collected once per file. Block bodies
        // own their comments; an adjacent expression directive marks one call.
        const skipDirectiveRanges: Range[] = [];

        const currentScope = (): FunctionScope | null => scopes.at(-1) ?? null;

        const pushScope = (node: unknown) => {
          const body =
            isAstNode(node) && isAstNode(node.body) ? node.body : null;
          // Block-body directives retain their existing function scope;
          // expression-body directives attach to the next mutation instead.
          const range =
            body?.type === "BlockStatement" ? asRange(body.range) : null;
          const childRange = isAstNode(node) ? asRange(node.range) : null;
          const parentScope = currentScope();
          if (parentScope && childRange !== null) {
            parentScope.childBodyRanges.push(childRange);
          }
          scopes.push({
            owner: ownerName(node),
            mutationNodes: [],
            hasAuditCall: false,
            bodyRange: range,
            childBodyRanges: [],
          });
        };

        const popAndReport = () => {
          const scope = scopes.pop();
          if (
            !scope ||
            scope.mutationNodes.length === 0 ||
            scope.hasAuditCall ||
            hasBodySkipDirective(scope, skipDirectiveRanges)
          ) {
            return;
          }
          if (isBudgeted()) {
            const owned = unauditedByOwner.get(scope.owner) ?? [];
            owned.push(...scope.mutationNodes);
            unauditedByOwner.set(scope.owner, owned);
            return;
          }
          for (const mutation of scope.mutationNodes) {
            context.report({ node: mutation.node, messageId: "missingAudit" });
          }
        };

        // Compares one owner's writes with its budget, target by target.
        const reportOwner = (program: Ranged, owner: string) => {
          const budgets = fileBudgets.get(owner) ?? new Map<string, number>();
          const writesByTarget = new Map<string, Mutation[]>();
          for (const write of unauditedByOwner.get(owner) ?? []) {
            writesByTarget.set(write.target, [
              ...(writesByTarget.get(write.target) ?? []),
              write,
            ]);
          }
          const targets = new Set([
            ...budgets.keys(),
            ...writesByTarget.keys(),
          ]);
          for (const target of targets) {
            const writes = writesByTarget.get(target) ?? [];
            const budget = budgets.get(target) ?? 0;
            const data = {
              actual: String(writes.length),
              budget: String(budget),
              owner,
              target,
            };
            if (writes.length > budget) {
              for (const write of writes) {
                context.report({
                  node: write.node,
                  messageId: "overBudget",
                  data,
                });
              }
            } else if (writes.length < budget) {
              context.report({ node: program, messageId: "staleBudget", data });
            }
          }
        };

        return {
          before() {
            scopes.length = 0;
            skipDirectiveRanges.length = 0;
            unauditedByOwner.clear();
            fileBudgets = new Map();
            census = false;
            systemFile = false;
          },
          "Program:exit"(node) {
            if (!isBudgeted()) {
              return;
            }
            const owners = new Set([
              ...fileBudgets.keys(),
              ...unauditedByOwner.keys(),
            ]);
            for (const owner of owners) {
              reportOwner(node, owner);
            }
          },
          Program(node) {
            const options = context.options.at(0);
            census = censusFromOptions(options);
            const relative = path
              .relative(
                rootFromOptions(options),
                path.resolve(filenameForContext(context)),
              )
              .replaceAll("\\", "/");
            const systemActor = systemModulesFromOptions(options).get(relative);
            if (systemActor !== undefined) {
              if (MEMBER_RUN_MODULE_FILES.has(relative)) {
                context.report({
                  node,
                  messageId: "memberRunSystemModule",
                  data: { file: relative },
                });
              } else if (
                typeof systemActor !== "string" ||
                !isSystemRunActor(systemActor)
              ) {
                context.report({
                  node,
                  messageId: "unknownSystemActor",
                  data: { file: relative, actor: JSON.stringify(systemActor) },
                });
              } else {
                systemFile = true;
              }
            }
            systemFile ||= relative === SYSTEM_AUDIT_RECORDER_FILE;
            const fileKey = `${relative}::`;
            fileBudgets = new Map(
              [...budgetsFromOptions(options)].flatMap(([key, budget]) =>
                key.startsWith(fileKey)
                  ? [[key.slice(fileKey.length), budget] as const]
                  : [],
              ),
            );
            const comments: unknown = "comments" in node ? node.comments : null;
            if (!Array.isArray(comments)) {
              return;
            }
            for (const comment of comments) {
              const range = isAstNode(comment) ? asRange(comment.range) : null;
              if (
                range !== null &&
                isAstNode(comment) &&
                typeof comment.value === "string" &&
                isJustifiedSkipDirective(comment.value)
              ) {
                skipDirectiveRanges.push(range);
              }
            }
          },
          FunctionDeclaration: pushScope,
          "FunctionDeclaration:exit": popAndReport,
          FunctionExpression: pushScope,
          "FunctionExpression:exit": popAndReport,
          ArrowFunctionExpression: pushScope,
          "ArrowFunctionExpression:exit": popAndReport,
          CallExpression(node) {
            const scope = currentScope();
            if (!scope) {
              return;
            }
            if (isAuditCall(context, node)) {
              scope.hasAuditCall = true;
            } else if (!systemFile && isDatabaseWriteCall(context, node)) {
              if (
                hasCallSkipDirective({
                  node,
                  source: context.sourceCode.text,
                  ranges: skipDirectiveRanges,
                })
              ) {
                return;
              }
              scope.mutationNodes.push({
                node,
                target: databaseWriteTarget(context, node),
              });
            }
          },
        };
      },
    },
  },
});
