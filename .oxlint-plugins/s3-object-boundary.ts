// Confine native S3 object I/O to the owned storage boundary.
//
// `apps/api/src/lib/s3.ts` owns cancellation, size, range, credential refresh,
// response validation, and the bounded write retry; `apps/api/src/lib/s3-presign.ts`
// owns the tenant-scoped presigned PUT. Both are excluded in oxlint.config.ts.
// Everywhere else, both rules ask one question of a receiver: is this a Bun S3
// client, or a file handle from one?
//
// A client is `getS3()` / `getCorpusS3()` imported from the owning module
// (under any alias, through a namespace import, or bound to a local first),
// `new S3Client(...)` / `new Bun.S3Client(...)` from Bun, or Bun's default
// client (`Bun.s3`, `import { s3 } from "bun"`). A file handle is `.file(key)`
// on a client. Resolution follows imports and never-reassigned locals, so a
// parameter or a same-named local does not inherit provenance.
//
// `no-native-s3-object-read` flags body-materialising reads off a file handle.
// Bun 1.4 fixes the native reader's retained-buffer bug, but native body reads
// still have no deadline.
//
// Flagged:
//   await getS3().file(key).arrayBuffer();
//   const handle = getCorpusS3().file(key); await handle.text();
//
// Allowed:
//   await getS3().file(key).exists();
//   await Bun.file("/tmp/local").arrayBuffer();
//
// `no-native-s3-object-write` flags `.write(...)` on a client or a file handle,
// `Bun.write(<file handle>, ...)`, and `client.send(new PutObjectCommand(...))`.
// A write that times out can still finish at S3 after the caller has moved on;
// `writeS3ObjectWithRetry` retries that ambiguous failure at the same key, so
// record-identity or content-addressed keys converge rather than leaving a new
// object behind for every attempt.
//
// Flagged:
//   await getS3().write(key, bytes);
//   await Bun.s3.file(key).write(bytes);
//   await client.send(new PutObjectCommand({ Key: key }));
//
// Allowed:
//   await writeS3ObjectWithRetry({ key, data: bytes });
//   await Bun.write("/tmp/local", bytes);

import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import type { ImportedFromOptions } from "./utils.ts";
import {
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isImportedFrom,
  invokedCallee,
  memberPropertyName,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

type RuleContext = ImportedFromOptions["context"];

const S3_OWNER_MODULE = "apps/api/src/lib/s3";
const S3_ACCESSORS: ReadonlySet<string> = new Set(["getS3", "getCorpusS3"]);
const BUN_MODULE = "bun";
const BUN_GLOBAL = "Bun";
const BUN_CLIENT_CLASS = "S3Client";
const BUN_DEFAULT_CLIENT = "s3";
const BUN_WRITE = "write";
const AWS_S3_MODULE = "@aws-sdk/client-s3";
const PUT_OBJECT_COMMAND = "PutObjectCommand";

// Body-materialising reads only. `.exists()`, `.stat()`, `.write()`,
// `.delete()`, and `.presign()` carry no response body.
const BODY_READS: ReadonlySet<string> = new Set([
  "arrayBuffer",
  "bytes",
  "text",
  "json",
]);

// `Bun.<name>` on the global, or `<name>` imported from "bun" (named,
// aliased, or read off a namespace import).
const isBunExport = (
  context: RuleContext,
  node: unknown,
  name: string,
): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return false;
  }
  if (
    expression.type === "MemberExpression" &&
    memberPropertyName(expression) === name &&
    isIdentifier(expression.object, BUN_GLOBAL) &&
    isIdentifierReference(expression.object) &&
    (resolveVariable(context, expression.object)?.defs.length ?? 0) === 0
  ) {
    return true;
  }
  return isImportedFrom({
    context,
    node: expression,
    modules: [BUN_MODULE],
    names: new Set([name]),
  });
};

// Follow a never-reassigned local to its initializer. Null for imports,
// parameters, reassigned bindings, and anything already visited.
const followLocal = (
  context: RuleContext,
  node: unknown,
  visited: Set<Variable>,
): unknown => {
  if (!isIdentifierReference(node)) {
    return null;
  }
  const variable = resolveVariable(context, node);
  if (variable === null || visited.has(variable)) {
    return null;
  }
  visited.add(variable);
  return stableInitializer(variable);
};

const isS3ClientExpression = (
  context: RuleContext,
  node: unknown,
  visited = new Set<Variable>(),
): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return false;
  }
  if (expression.type === "CallExpression") {
    return isImportedFrom({
      context,
      node: invokedCallee(expression),
      modules: [S3_OWNER_MODULE],
      names: S3_ACCESSORS,
    });
  }
  if (expression.type === "NewExpression") {
    return isBunExport(context, expression.callee, BUN_CLIENT_CLASS);
  }
  if (isBunExport(context, expression, BUN_DEFAULT_CLIENT)) {
    return true;
  }
  const initializer = followLocal(context, expression, visited);
  return (
    initializer !== null && isS3ClientExpression(context, initializer, visited)
  );
};

const isS3FileExpression = (
  context: RuleContext,
  node: unknown,
  visited = new Set<Variable>(),
): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return false;
  }
  if (expression.type === "CallExpression") {
    const callee = unwrapExpression(expression.callee);
    return (
      callee?.type === "MemberExpression" &&
      memberPropertyName(callee) === "file" &&
      isS3ClientExpression(context, callee.object)
    );
  }
  const initializer = followLocal(context, expression, visited);
  return (
    initializer !== null && isS3FileExpression(context, initializer, visited)
  );
};

const isPutObjectCommand = (
  context: RuleContext,
  node: unknown,
  visited = new Set<Variable>(),
): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return false;
  }
  if (expression.type === "NewExpression") {
    return isImportedFrom({
      context,
      node: expression.callee,
      modules: [AWS_S3_MODULE],
      names: new Set([PUT_OBJECT_COMMAND]),
    });
  }
  const initializer = followLocal(context, expression, visited);
  return (
    initializer !== null && isPutObjectCommand(context, initializer, visited)
  );
};

const firstArgument = (call: Record<string, unknown>): unknown =>
  Array.isArray(call.arguments) ? call.arguments.at(0) : undefined;

export default eslintCompatPlugin({
  meta: { name: "s3-object-boundary" },
  rules: {
    "no-native-s3-object-read": {
      meta: {
        type: "problem",
        messages: {
          noNativeS3ObjectRead:
            "Do not read an S3 object body with .{{method}}() outside the " +
            "owned storage boundary. Use the appropriate read helper from " +
            "@/api/lib/s3 so cancellation, bounds, credentials, and errors " +
            "remain consistent.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node: unknown) {
            if (!isAstNode(node)) {
              return;
            }
            const callee = unwrapExpression(node.callee);
            if (callee?.type !== "MemberExpression") {
              return;
            }
            const method = memberPropertyName(callee);
            if (
              method === null ||
              !BODY_READS.has(method) ||
              !isS3FileExpression(context, callee.object)
            ) {
              return;
            }
            context.report({
              node,
              messageId: "noNativeS3ObjectRead",
              data: { method },
            });
          },
        };
      },
    },
    "no-native-s3-object-write": {
      meta: {
        type: "problem",
        messages: {
          noNativeS3ObjectWrite:
            "Do not write an S3 object with native I/O outside the owned " +
            "storage boundary; use writeS3ObjectWithRetry() (documents) or " +
            "putCorpusS3ObjectWithSignal() (corpus) from @/api/lib/s3 so " +
            "bounded retries converge at the same deterministic key.",
        },
      },
      createOnce(context) {
        const isNativeWrite = (call: Record<string, unknown>): boolean => {
          const callee = unwrapExpression(call.callee);
          if (callee === null) {
            return false;
          }
          if (isBunExport(context, callee, BUN_WRITE)) {
            return isS3FileExpression(context, firstArgument(call));
          }
          if (callee.type !== "MemberExpression") {
            return false;
          }
          const method = memberPropertyName(callee);
          if (method === BUN_WRITE) {
            return (
              isS3ClientExpression(context, callee.object) ||
              isS3FileExpression(context, callee.object)
            );
          }
          return (
            method === "send" &&
            isPutObjectCommand(context, firstArgument(call))
          );
        };

        return {
          CallExpression(node: unknown) {
            if (!isAstNode(node) || !isNativeWrite(node)) {
              return;
            }
            context.report({ node, messageId: "noNativeS3ObjectWrite" });
          },
        };
      },
    },
  },
});
