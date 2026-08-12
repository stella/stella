// Keep Valkey key positions on the shared key builder.
//
// `lib/redis-keys.ts` is what makes a key cluster-legal: it puts a `{hashtag}`
// on the colocation unit so a multi-key command or Lua script lands on one
// slot, and it forces each scope to declare an expiry. A hand-written key
// string bypasses both, and the failure only shows up on a cluster, long after
// review. So a literal may not appear in the key position of a Valkey command.
//
// Scope: the `client.send("<COMMAND>", [...])` form, which is how every Lua
// script and multi-key command in this codebase is issued. Typed client
// methods (`redis.get`, `redis.set`) are covered instead by their signatures
// taking `CoordinationKey`, which a raw string does not satisfy.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import { filenameForContext, isAstNode, isStringLiteral } from "./utils.ts";

// Commands whose first argument is a key, and nothing after it is.
const SINGLE_KEY_COMMANDS = new Set([
  "DECR",
  "DECRBY",
  "EXPIRE",
  "EXPIREAT",
  "GET",
  "GETDEL",
  "GETEX",
  "HDEL",
  "HGET",
  "HGETALL",
  "HINCRBY",
  "HSET",
  "INCR",
  "INCRBY",
  "LPUSH",
  "LRANGE",
  "PERSIST",
  "PEXPIRE",
  "PTTL",
  "RPUSH",
  "SADD",
  "SCARD",
  "SET",
  "SETEX",
  "SETNX",
  "SISMEMBER",
  "SMEMBERS",
  "SREM",
  "TTL",
  "ZADD",
  "ZRANGE",
  "ZREM",
]);

// Commands taking a variadic key list, so every argument is a key.
const KEY_LIST_COMMANDS = new Set([
  "DEL",
  "EXISTS",
  "MGET",
  "TOUCH",
  "UNLINK",
  "WATCH",
]);

// Scripting: [script, numkeys, ...keys, ...argv].
const SCRIPT_COMMANDS = new Set(["EVAL", "EVALSHA", "FCALL", "FCALL_RO"]);
const SCRIPT_NUMKEYS_INDEX = 1;
const SCRIPT_FIRST_KEY_INDEX = 2;

const KEY_BUILDER_MODULE = "apps/api/src/lib/redis-keys.ts";

const commandName = (node: unknown): string | null =>
  isStringLiteral(node) ? node.value.toUpperCase() : null;

const isTemplateLiteral = (
  node: unknown,
): node is AstNode & { type: "TemplateLiteral" } =>
  isAstNode(node) && node.type === "TemplateLiteral";

// How many leading elements of the argument array are keys. Returns 0 for a
// command this rule does not police.
const keyArgumentCount = (command: string, argumentCount: number): number => {
  if (SINGLE_KEY_COMMANDS.has(command)) {
    return Math.min(1, argumentCount);
  }
  if (KEY_LIST_COMMANDS.has(command)) {
    return argumentCount;
  }
  return 0;
};

export default eslintCompatPlugin({
  meta: { name: "require-coordination-key" },
  rules: {
    "require-coordination-key": {
      meta: {
        type: "problem",
        messages: {
          literalKey:
            "Build Valkey keys with coordinationKey() from '@/api/lib/redis-keys' instead of a literal. " +
            "The builder places the {hashtag} that keeps a multi-key command on one cluster slot and forces the scope to declare an expiry.",
        },
        schema: [],
      },
      createOnce(context) {
        const reportLiteralKeys = (
          elements: readonly unknown[],
          from: number,
          count: number,
        ): void => {
          for (const element of elements.slice(from, from + count)) {
            if (isStringLiteral(element) || isTemplateLiteral(element)) {
              context.report({ node: element, messageId: "literalKey" });
            }
          }
        };

        return {
          before() {
            return !filenameForContext(context).endsWith(KEY_BUILDER_MODULE);
          },
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee?.type !== "MemberExpression" ||
              callee.computed ||
              callee.property?.name !== "send"
            ) {
              return;
            }
            const [commandNode, argumentsNode] = node.arguments ?? [];
            const command = commandName(commandNode);
            if (command === null || argumentsNode?.type !== "ArrayExpression") {
              return;
            }
            const elements = argumentsNode.elements ?? [];

            if (SCRIPT_COMMANDS.has(command)) {
              const declared = elements[SCRIPT_NUMKEYS_INDEX];
              // A non-literal numkeys hides how many keys follow; police the
              // first key position rather than trusting the call site.
              const numberOfKeys = isStringLiteral(declared)
                ? Number(declared.value)
                : 1;
              reportLiteralKeys(
                elements,
                SCRIPT_FIRST_KEY_INDEX,
                Number.isSafeInteger(numberOfKeys) && numberOfKeys > 0
                  ? numberOfKeys
                  : 1,
              );
              return;
            }

            reportLiteralKeys(
              elements,
              0,
              keyArgumentCount(command, elements.length),
            );
          },
        };
      },
    },
  },
});
