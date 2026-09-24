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
// Scope: apps/api/src/handlers/**/*.ts only.
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
//
// Allows:
//   - The function calls an audit recorder: the handler context's injected
//     recorder (`recordAuditEvent`, `ctx.recordAuditEvent`, a
//     `record*AuditEvent` parameter), a recorder built by the audit-log
//     factories, or an imported audited helper (`auditedPresignDownload`,
//     `recordWebhookAuditEvent`, `recordCorpusWithdrawalAuditEvent`). A
//     locally defined function of the same name does not count.
//   - The function carries a `// audit: skip - <reason>` directive in its own
//     body, with a reason of at least three words. The `audit-skip-directives`
//     ratchet metric counts these directives so they can only shrink.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Ranged, Variable } from "@oxlint/plugins";

import {
  type ImportedFromOptions,
  getCalleeName,
  invokedCallee,
  isAstNode,
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

const MUTATION_METHODS: ReadonlySet<string> = new Set([
  "insert",
  "update",
  "delete",
]);

const isDatabaseHandleName = (name: string): boolean =>
  name === "tx" ||
  name === "db" ||
  name === "trx" ||
  /[a-z](?:Tx|Db)$/u.test(name);

const GET_DB_CALL = /^get[A-Za-z]*Db$/u;
const TRANSACTION_TYPE = /(?:^|[a-z])(?:Transaction|Tx)$|^(?:Db|DbOrTx)$/u;

// Static SQL that writes rows. Interpolations are joined as a placeholder
// token so `UPDATE ${table} AS t SET` still reads as one statement.
const WRITE_SQL = [
  /\bINSERT\s+INTO\b/iu,
  /\bDELETE\s+FROM\b/iu,
  /\bUPDATE\s+(?:ONLY\s+)?\S+(?:\s+(?:AS\s+)?\w+)?\s+SET\b/iu,
];
const SQL_PLACEHOLDER = " __value__ ";

const AUDIT_RECORDER_NAME =
  /^(?:record[A-Z][A-Za-z0-9]*?AuditEvents?|recordAuditEvent)$/u;

// Imported helpers that write their own audit row.
const AUDITED_HELPERS = [
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
] as const;
const AUDIT_LOG_MODULE = "apps/api/src/lib/audit-log";
const AUDIT_RECORDER_FACTORIES: ReadonlySet<string> = new Set([
  "createAuditRecorder",
  "createBackgroundAuditRecorder",
]);
const DRIZZLE_SQL: ReadonlySet<string> = new Set(["sql"]);

const isDrizzleModule = (moduleId: string): boolean =>
  moduleId === "drizzle-orm" || moduleId.startsWith("drizzle-orm/");

// Guards the identifier-to-initializer walks against cycles.
const MAX_RESOLVE_DEPTH = 4;

const SKIP_DIRECTIVE = /audit:\s*skip\b(?<reason>.*)$/isu;
const MIN_SKIP_REASON_WORDS = 3;

// Whether a comment is an `audit: skip - <reason>` directive with a reason of
// at least three words.
const isJustifiedSkipDirective = (text: string): boolean => {
  const reason = SKIP_DIRECTIVE.exec(text)?.groups?.reason ?? "";
  const words = reason.split(/\s+/u).filter((word) => /\p{L}/u.test(word));
  return words.length >= MIN_SKIP_REASON_WORDS;
};

const typeAnnotationName = (identifier: unknown): string | null => {
  if (!isAstNode(identifier) || !isAstNode(identifier.typeAnnotation)) {
    return null;
  }
  const annotation = identifier.typeAnnotation.typeAnnotation;
  if (!isAstNode(annotation) || annotation.type !== "TSTypeReference") {
    return null;
  }
  const typeName = annotation.typeName;
  if (isIdentifier(typeName)) {
    return typeName.name;
  }
  return isAstNode(typeName) && typeName.type === "TSQualifiedName"
    ? getCalleeName(typeName.right)
    : null;
};

// Whether a function is the callback of `<handle>.transaction(...)`.
const isTransactionCallback = (fn: unknown): boolean => {
  const call = isAstNode(fn) ? fn.parent : null;
  if (!isAstNode(call) || call.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  return (
    callee?.type === "MemberExpression" &&
    memberPropertyName(callee) === "transaction" &&
    Array.isArray(call.arguments) &&
    call.arguments.includes(fn)
  );
};

const isTransactionParameter = (variable: Variable): boolean => {
  const definition = variable.defs.at(0);
  if (variable.defs.length !== 1 || definition?.type !== "Parameter") {
    return false;
  }
  const typeName = typeAnnotationName(definition.name);
  return (
    (typeName !== null && TRANSACTION_TYPE.test(typeName)) ||
    isTransactionCallback(definition.node)
  );
};

const isDatabaseHandle = (context: RuleContext, node: unknown): boolean => {
  const receiver = unwrapExpression(node);
  if (receiver === null) {
    return false;
  }
  if (isIdentifierReference(receiver)) {
    if (isDatabaseHandleName(receiver.name)) {
      return true;
    }
    const variable = resolveVariable(context, receiver);
    return variable !== null && isTransactionParameter(variable);
  }
  if (receiver.type === "MemberExpression") {
    const property = memberPropertyName(receiver);
    return property !== null && isDatabaseHandleName(property);
  }
  if (receiver.type === "CallExpression") {
    const name = getCalleeName(receiver.callee)?.split(".").at(-1);
    return name !== undefined && GET_DB_CALL.test(name);
  }
  return false;
};

// The static text of a drizzle `sql` template, or of a const holding one.
const writeSqlText = (
  context: RuleContext,
  node: unknown,
  depth = 0,
): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null || depth > MAX_RESOLVE_DEPTH) {
    return null;
  }
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    const init = variable === null ? null : stableInitializer(variable);
    return init === null ? null : writeSqlText(context, init, depth + 1);
  }
  if (
    expression.type !== "TaggedTemplateExpression" ||
    !isImportedFrom({
      context,
      node: expression.tag,
      modules: [isDrizzleModule],
      names: DRIZZLE_SQL,
    }) ||
    !isAstNode(expression.quasi) ||
    !Array.isArray(expression.quasi.quasis)
  ) {
    return null;
  }
  return expression.quasi.quasis
    .map((quasi: unknown) => {
      const value = isAstNode(quasi) ? quasi.value : null;
      return typeof value === "object" &&
        value !== null &&
        "raw" in value &&
        typeof value.raw === "string"
        ? value.raw
        : "";
    })
    .join(SQL_PLACEHOLDER);
};

const isMutationCall = (context: RuleContext, node: unknown): boolean => {
  const call = unwrapExpression(node);
  if (call?.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const method = memberPropertyName(callee);
  if (method !== null && MUTATION_METHODS.has(method)) {
    return isDatabaseHandle(context, callee.object);
  }
  if (method !== "execute" || !Array.isArray(call.arguments)) {
    return false;
  }
  const text = writeSqlText(context, call.arguments.at(0));
  return text !== null && WRITE_SQL.some((pattern) => pattern.test(text));
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
      modules: [AUDIT_LOG_MODULE],
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

type FunctionScope = {
  mutationNodes: Ranged[];
  hasAuditCall: boolean;
  hasSkipDirective: boolean;
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

export default eslintCompatPlugin({
  meta: { name: "require-audit-on-mutation" },
  rules: {
    "require-audit-on-mutation": {
      meta: {
        type: "problem",
        messages: {
          missingAudit:
            "This function writes to the database (insert / update / " +
            "delete, or a raw write through execute) but does not call an " +
            "audit recorder. Add an audit emission in the same transaction, " +
            "or annotate the function with `// audit: skip - <reason>` (at " +
            "least three words) if the write legitimately needs no audit " +
            "row (presigned URL bookkeeping, scheduler runs, ephemeral state).",
        },
      },
      createOnce(context) {
        const scopes: FunctionScope[] = [];
        // Justified `audit: skip - <reason>` comments, collected once per
        // file; each marks only the innermost function whose own body holds
        // it.
        const skipDirectiveRanges: Range[] = [];

        const currentScope = (): FunctionScope | null => scopes.at(-1) ?? null;

        const pushScope = (node: unknown) => {
          const body =
            isAstNode(node) && isAstNode(node.body) ? node.body : null;
          // An expression-bodied arrow owns a directive written between `=>`
          // and its expression, so its whole span is the body.
          const owner = body?.type === "BlockStatement" ? body : node;
          const range = isAstNode(owner) ? asRange(owner.range) : null;
          const parentScope = currentScope();
          if (parentScope && range !== null) {
            parentScope.childBodyRanges.push(range);
          }
          scopes.push({
            mutationNodes: [],
            hasAuditCall: false,
            hasSkipDirective: false,
            bodyRange: range,
            childBodyRanges: [],
          });
        };

        const applySkipDirectives = () => {
          const scope = currentScope();
          if (!scope || !scope.bodyRange) {
            return;
          }
          const [start, end] = scope.bodyRange;
          scope.hasSkipDirective = skipDirectiveRanges.some(
            ([commentStart]) =>
              commentStart >= start &&
              commentStart <= end &&
              !scope.childBodyRanges.some(
                ([childStart, childEnd]) =>
                  commentStart >= childStart && commentStart <= childEnd,
              ),
          );
        };

        const popAndReport = () => {
          applySkipDirectives();
          const scope = scopes.pop();
          if (
            !scope ||
            scope.mutationNodes.length === 0 ||
            scope.hasAuditCall ||
            scope.hasSkipDirective
          ) {
            return;
          }
          for (const mutation of scope.mutationNodes) {
            context.report({ node: mutation, messageId: "missingAudit" });
          }
        };

        return {
          before() {
            scopes.length = 0;
            skipDirectiveRanges.length = 0;
          },
          Program(node) {
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
            } else if (isMutationCall(context, node)) {
              scope.mutationNodes.push(node);
            }
          },
        };
      },
    },
  },
});
