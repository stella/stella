// Forbid eager construction of known side-effecting singletons
// (DB connections, auth clients, Redis/queue connections, S3 clients) at
// module top level (Program scope), including top-level `const x = ...`.
//
// CLAUDE.md "Module Side Effects": defer eager initialization with lazy
// singletons. When a module-level call depends on another module's export,
// wrap it in a `getX()` getter so it runs at first use, not at import
// time — this prevents TDZ errors from non-deterministic module
// evaluation order.
//
// This rule is deliberately narrow: it does not try to flag "any top-level
// side effect" (schema/valibot/style definitions are legitimate top-level
// calls and a broad rule would drown in false positives). It only matches
// a denylist of known side-effecting constructors actually used in this
// codebase: `drizzle(`, `betterAuth(`, `createRedisClient(`, `new
// RedisClient(`, `new Queue(` / `new Worker(` (BullMQ), `new S3Client(`,
// `postgres(` / `new SQL(`.
//
// Flags:
//   export const rootDb = drizzle({ client });          // top level
//   const auth = betterAuth({ ... });                   // top level
//   const redis = createRedisClient();                  // top level
//   if (cond) { const q = new Queue("x", opts); }        // still top level
//
// Allows:
//   const getDb = () => drizzle({ client });            // behind a function
//   let _db; const getDb = () => (_db ??= drizzle(...)); // lazy singleton
//   function build() { return new S3Client(opts); }      // behind a function
//
// Files that legitimately construct these at import time (the canonical,
// always-imported-once singleton module; a standalone CLI entrypoint never
// imported by other modules) are exempted per-file in `oxlint.config.ts`,
// with a comment explaining why. New singleton modules must use the lazy
// `getX()` pattern instead of adding to that exemption list.

import { isIdentifier } from "./utils.ts";

const CALL_DENYLIST = new Set([
  "drizzle",
  "betterAuth",
  "createRedisClient",
  "postgres",
]);

const NEW_DENYLIST = new Set([
  "RedisClient",
  "Queue",
  "Worker",
  "S3Client",
  "SQL",
]);

export default {
  meta: { name: "no-eager-singleton" },
  rules: {
    "no-eager-singleton": {
      meta: {
        type: "problem",
        messages: {
          eagerSingleton:
            "'{{name}}(...)' must not run at module top level; it eagerly " +
            "constructs a side-effecting singleton at import time, which " +
            "can trigger TDZ errors under non-deterministic module " +
            "evaluation order. Wrap it in a lazy `getX()` singleton getter " +
            "that runs at first use instead (see getAuth() in " +
            "apps/api/src/lib/auth.ts or getS3() in apps/api/src/lib/s3.ts).",
        },
      },
      create(context) {
        let functionDepth = 0;

        const enterFunction = () => {
          functionDepth += 1;
        };
        const exitFunction = () => {
          functionDepth -= 1;
        };

        return {
          Program() {
            functionDepth = 0;
          },
          FunctionDeclaration: enterFunction,
          "FunctionDeclaration:exit": exitFunction,
          FunctionExpression: enterFunction,
          "FunctionExpression:exit": exitFunction,
          ArrowFunctionExpression: enterFunction,
          "ArrowFunctionExpression:exit": exitFunction,

          CallExpression(node) {
            if (functionDepth > 0) {
              return;
            }
            const callee = node.callee;
            if (isIdentifier(callee) && CALL_DENYLIST.has(callee.name)) {
              context.report({
                node,
                messageId: "eagerSingleton",
                data: { name: callee.name },
              });
            }
          },

          NewExpression(node) {
            if (functionDepth > 0) {
              return;
            }
            const callee = node.callee;
            if (isIdentifier(callee) && NEW_DENYLIST.has(callee.name)) {
              context.report({
                node,
                messageId: "eagerSingleton",
                data: { name: `new ${callee.name}` },
              });
            }
          },
        };
      },
    },
  },
};
