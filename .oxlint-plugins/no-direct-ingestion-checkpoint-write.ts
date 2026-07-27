// Require ingestion cursor writes to cross the canonical replay-safe
// checkpoint boundary.
//
// This rule intentionally proves one local property only: a Drizzle-shaped
// `db.update(...).set({ syncCursor })` write is visibly owned by
// `advanceCorpusIngestionCheckpoint` or `commitReplaySafeIngestionBatch`. Unique
// source identity, idempotent item writes, external-side-effect durability,
// and retry behavior remain schema/design/test responsibilities.
//
// Flags:
//   await tx.update(sources).set({ syncCursor }).where(...);
//   await scopedDb((scopedTx) =>
//     scopedTx.update(sources).set({ "syncCursor": cursor }).where(...)
//   );
//
// Allows:
//   await commitReplaySafeIngestionBatch({
//     checkpoint,
//     persistCheckpoint: (tx, value) =>
//       tx.update(sources).set({ syncCursor: value }).where(...),
//     runInTransaction: scopedDb,
//   });
//   await tx.update(sources).set({ lastSyncAt: new Date() }).where(...);
//   await tx.insert(sources).values({ syncCursor: null });

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  unwrapExpression,
} from "./utils.ts";

const CHECKPOINT_HELPERS = new Set(["commitReplaySafeIngestionBatch"]);

const CHECKPOINT_MODULE = "apps/api/src/lib/corpus-ingestion-checkpoint.ts";

const filenameForContext = (context) =>
  (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");

const isNonComputedMember = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  node.computed === false;

const isTransactionRoot = (node: unknown): boolean => {
  if (!isIdentifier(node)) {
    return false;
  }
  return (
    node.name === "db" ||
    node.name === "tx" ||
    node.name.endsWith("Db") ||
    node.name.endsWith("Tx")
  );
};

const getDrizzleSetObject = (node: unknown) => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return null;
  }
  const setCallee = unwrapExpression(node.callee);
  if (
    !isNonComputedMember(setCallee) ||
    getPropertyName(setCallee?.property) !== "set"
  ) {
    return null;
  }

  const updateCall = unwrapExpression(setCallee?.object);
  if (!isAstNode(updateCall) || updateCall.type !== "CallExpression") {
    return null;
  }
  const updateCallee = unwrapExpression(updateCall.callee);
  if (
    !isNonComputedMember(updateCallee) ||
    getPropertyName(updateCallee?.property) !== "update" ||
    !isTransactionRoot(updateCallee?.object)
  ) {
    return null;
  }

  if (!Array.isArray(node.arguments)) {
    return null;
  }
  const setArgument = node.arguments.at(0);
  const object = unwrapExpression(setArgument);
  return isAstNode(object) && object.type === "ObjectExpression"
    ? object
    : null;
};

const isCheckpointCallback = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const property = node.parent;
  if (
    !isAstNode(property) ||
    property.type !== "Property" ||
    getPropertyName(property.key) !== "persistCheckpoint" ||
    property.value !== node
  ) {
    return false;
  }
  const options = property.parent;
  const call = isAstNode(options) ? options.parent : null;
  return (
    isAstNode(options) &&
    options.type === "ObjectExpression" &&
    isAstNode(call) &&
    call.type === "CallExpression" &&
    isIdentifier(call.callee) &&
    CHECKPOINT_HELPERS.has(call.callee.name)
  );
};

const isInsideCheckpointBoundary = (node: unknown): boolean => {
  let current = isAstNode(node) ? node.parent : null;
  while (isAstNode(current)) {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionExpression"
    ) {
      return isCheckpointCallback(current);
    }
    if (current.type === "FunctionDeclaration") {
      return false;
    }
    current = current.parent;
  }
  return false;
};

export default {
  meta: { name: "no-direct-ingestion-checkpoint-write" },
  rules: {
    "no-direct-ingestion-checkpoint-write": {
      meta: {
        type: "problem",
        messages: {
          directCheckpointWrite:
            "Persist syncCursor through advanceCorpusIngestionCheckpoint or commitReplaySafeIngestionBatch so stale or failed work cannot move the checkpoint.",
        },
        schema: [],
      },
      create(context) {
        if (filenameForContext(context).endsWith(CHECKPOINT_MODULE)) {
          return {};
        }

        return {
          CallExpression(node) {
            const object = getDrizzleSetObject(node);
            if (object === null || isInsideCheckpointBoundary(node)) {
              return;
            }

            if (!Array.isArray(object.properties)) {
              return;
            }
            for (const property of object.properties) {
              if (
                property.type === "Property" &&
                getPropertyName(property.key) === "syncCursor"
              ) {
                context.report({
                  node: property.key,
                  messageId: "directCheckpointWrite",
                });
              }
            }
          },
        };
      },
    },
  },
};
