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
// Flags (one report per offending function):
//   await safeDb(async (tx) => {
//     await tx.insert(entities).values(...);
//     // ^^ no recordAuditEvent or auditedPresignDownload call in this function
//   });
//
// Allows:
//   - The function contains a `recordAuditEvent(tx, ...)` call (any callee
//     ending in `.recordAuditEvent` or the bare identifier).
//   - The function contains an `auditedPresignDownload(...)` call (the
//     helper writes the audit row itself).
//   - The function carries a `// audit: skip — <reason>` directive somewhere
//     in its body. Use this for legitimate non-audit writes
//     (presigned URL bookkeeping, scheduler tick updates, ephemeral UI
//     state). The reason text is required so reviewers can sanity-check.
//
// Detected mutations: `tx.insert(...)`, `tx.update(...)`, `tx.delete(...)`,
// where `tx` is any identifier ending in `tx`, `Tx`, `db`, or `Db`
// (covers tx, innerTx, scopedDb, safeDb at the call site).

import { getCalleeName, getPropertyName } from "./utils.ts";

type AstNode = { type: string } & Record<string, unknown>;

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof (node as { type: unknown }).type === "string";

const MUTATION_METHODS = new Set(["insert", "update", "delete"]);

// The transaction parameter is conventionally one of these names.
// Anything else (e.g. a custom alias) won't be matched — false negatives
// are acceptable; false positives on non-DB code would be noisier.
const TX_NAME_PATTERN = /(?:^|[a-z])(tx|Db)$/u;

const isMutationCall = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = node.callee;
  if (!isAstNode(callee) || callee.type !== "MemberExpression") {
    return false;
  }
  if (callee.computed !== false) {
    return false;
  }
  const propertyName = getPropertyName(callee.property);
  if (propertyName === null || !MUTATION_METHODS.has(propertyName)) {
    return false;
  }
  const object = callee.object;
  if (!isAstNode(object) || object.type !== "Identifier") {
    return false;
  }
  const objectName = typeof object.name === "string" ? object.name : null;
  if (objectName === null) {
    return false;
  }
  return TX_NAME_PATTERN.test(objectName);
};

// Match callees whose tail name is `recordAuditEvent`, `auditedPresignDownload`,
// or a `record*AuditEvent` / `record*AuditEvents` alias used when a single
// handler binds multiple recorders (e.g. `recordSourceAuditEvent`,
// `recordTargetAuditEvent` in cross-workspace operations).
const AUDIT_CALLEE_PATTERN =
  /^(?:record[A-Z][A-Za-z0-9]*?AuditEvents?|recordAuditEvent|auditedPresignDownload)$/u;

const isAuditCall = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const calleeName = getCalleeName(node.callee);
  if (calleeName === null) {
    return false;
  }
  const tail = calleeName.split(".").at(-1);
  return tail !== undefined && AUDIT_CALLEE_PATTERN.test(tail);
};

type Range = [number, number];

type FunctionScope = {
  mutationNodes: unknown[];
  hasAuditCall: boolean;
  hasSkipDirective: boolean;
  bodyRange: Range | null;
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

export default {
  meta: { name: "require-audit-on-mutation" },
  rules: {
    "require-audit-on-mutation": {
      meta: {
        type: "problem",
        messages: {
          missingAudit:
            "This function writes to the database (tx.insert / update / " +
            "delete) but does not call recordAuditEvent or " +
            "auditedPresignDownload. Add an audit emission in the same " +
            "transaction, or annotate the function with " +
            "`// audit: skip — <reason>` if the write legitimately needs " +
            "no audit row (presigned URL bookkeeping, scheduler runs, " +
            "ephemeral state).",
        },
      },
      create(context) {
        const scopes: FunctionScope[] = [];

        const pushScope = (node: unknown) => {
          const body = isAstNode(node) && "body" in node ? node.body : null;
          const range = isAstNode(body) ? asRange(body.range) : null;
          scopes.push({
            mutationNodes: [],
            hasAuditCall: false,
            hasSkipDirective: false,
            bodyRange: range,
          });
        };

        const currentScope = (): FunctionScope | null => scopes.at(-1) ?? null;

        const popAndReport = () => {
          const scope = scopes.pop();
          if (!scope) {
            return;
          }
          if (scope.mutationNodes.length === 0) {
            return;
          }
          if (scope.hasAuditCall || scope.hasSkipDirective) {
            return;
          }
          for (const mutation of scope.mutationNodes) {
            context.report({ node: mutation, messageId: "missingAudit" });
          }
        };

        const recordCall = (node: unknown) => {
          const scope = currentScope();
          if (!scope) {
            return;
          }
          if (isAuditCall(node)) {
            scope.hasAuditCall = true;
            return;
          }
          if (isMutationCall(node)) {
            scope.mutationNodes.push(node);
          }
        };

        // Comment-based skip directive. Oxlint plugins receive the full
        // source via context.sourceCode; comments are exposed on the
        // root program. We collect all `audit: skip` comments once and
        // mark any function whose body range encloses one.
        const skipDirectiveRanges: Range[] = [];

        return {
          Program(node) {
            const comments =
              isAstNode(node) &&
              "comments" in node &&
              Array.isArray(node.comments)
                ? node.comments
                : [];
            for (const comment of comments) {
              if (
                !isAstNode(comment) ||
                !("value" in comment) ||
                typeof comment.value !== "string" ||
                !/audit:\s*skip/iu.test(comment.value)
              ) {
                continue;
              }
              const range = asRange(comment.range);
              if (range !== null) {
                skipDirectiveRanges.push(range);
              }
            }
          },
          FunctionDeclaration(node) {
            pushScope(node);
          },
          "FunctionDeclaration:exit"() {
            applySkipDirectives();
            popAndReport();
          },
          FunctionExpression(node) {
            pushScope(node);
          },
          "FunctionExpression:exit"() {
            applySkipDirectives();
            popAndReport();
          },
          ArrowFunctionExpression(node) {
            pushScope(node);
          },
          "ArrowFunctionExpression:exit"() {
            applySkipDirectives();
            popAndReport();
          },
          CallExpression(node) {
            recordCall(node);
          },
        };

        function applySkipDirectives() {
          const scope = currentScope();
          if (!scope || !scope.bodyRange) {
            return;
          }
          const [start, end] = scope.bodyRange;
          for (const [commentStart] of skipDirectiveRanges) {
            if (commentStart >= start && commentStart <= end) {
              scope.hasSkipDirective = true;
              return;
            }
          }
        }
      },
    },
  },
};
