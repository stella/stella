// Ban an `await` of a network call lexically inside a loop body.
//
// A per-iteration round-trip serializes latency: the loop costs
// `iterations x RTT`, and the cost grows with input the caller controls.
// The fix is a bounded fan-out — `Promise.all` / `Promise.allSettled` over a
// chunk, under a concurrency cap. Where the sequence is the point (a
// rate-limited upstream, an ordered write, a cursor whose next request
// depends on this response), the suppression reason records that decision.
//
// Detection is lexical and binding-based, never name-guessing:
//   - Global `fetch(...)`, `globalThis.fetch(...)`, `window.fetch(...)`,
//     `self.fetch(...)`.
//   - A call to a binding imported from a fetch-owning module:
//     `@stll/fetch` (packages/fetch) and its two re-export shims
//     `@/lib/fetch` (apps/web) and `@/api/lib/fetch`, plus the api's other
//     HTTP helpers `@/api/lib/safe-outbound-fetch` and
//     `@/api/lib/redirect-fetch`. Modules are matched by import source, so a
//     local helper that merely spells `fetchSomething` is not a network call
//     and an aliased import still is.
//   - `client.send(new SomeCommand(...))`: the AWS SDK command dispatch
//     shape. The `new *Command(...)` argument is required, so an unrelated
//     `transport.send(message)` stays out of scope.
//   - A method call on a binding imported from `@aws-sdk/*`,
//     `@stll/api-client`, or the Eden client (`@/lib/eden-client` and its
//     `@/lib/api` barrel, which export `api` / `memoriesApi`), e.g.
//     `await api.documents({ id }).get()`.
//
// "Inside a loop" walks up `parent` links from the await, stopping at the
// first `for` / `for-of` / `for-in` / `while` / `do-while` whose BODY is the
// ancestor (an await in the loop head is not a per-iteration call), or at the
// first function boundary — a network await inside a nested function belongs
// to that function's own call site.
//
// `yield* Result.await(fetchWithTimeout(...))` is the same operation written
// on the Result boundary and is treated as an await.
//
// Flags:
//   for (const id of ids) { await fetch(`/items/${id}`); }
//   for (const key of keys) { await s3.send(new GetObjectCommand({ key })); }
//   while (cursor) { await api.documents.list.get({ query: { cursor } }); }
//
// Allows:
//   await Promise.all(chunk.map((id) => fetch(`/items/${id}`)));
//   for await (const chunk of response.body) { consume(chunk); }
//     // the iteration's implicit await is not an `AwaitExpression`; a stream
//     // is inherently sequential and has no fan-out to batch
//   for (const id of ids) { const load = () => fetch(url); queue.push(load); }
//     // defined, not awaited per iteration
//
// A loop that carries state between iterations (a cursor, a retry backoff, a
// rate limit) is a real exception, not an oversight, and is accepted only
// with a directive that says so:
//   // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- <why the sequence is required>
//
// Boundary: imports only. A client passed in as a parameter, re-exported
// through a local barrel, or read off an object built elsewhere is not
// tracked; neither is a network call reached through a helper the loop body
// calls. Both are deliberate — the rule proves the shapes it names and
// leaves whole-program taint analysis to review.

import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import {
  getImportLocalName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const LOOP_TYPES = new Set([
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

// Modules whose exported functions perform an HTTP request. Every binding
// imported from them counts, so an added helper is covered on the day it
// ships rather than when someone remembers to list its name.
const FETCH_MODULES = new Set([
  "@stll/fetch",
  "@/lib/fetch",
  "@/api/lib/fetch",
  "@/api/lib/safe-outbound-fetch",
  "@/api/lib/redirect-fetch",
]);

// Modules whose exported objects are remote clients: any method call on one
// of their bindings is a round-trip.
const CLIENT_MODULES = new Set([
  "@stll/api-client",
  "@/lib/eden-client",
  "@/lib/api",
]);

const CLIENT_MODULE_PREFIX = "@aws-sdk/";

const GLOBAL_FETCH_OBJECTS = new Set(["globalThis", "window", "self"]);

const getType = (node: unknown): string | null =>
  isAstNode(node) ? node.type : null;

const getField = (node: unknown, field: string): unknown => {
  if (typeof node !== "object" || node === null || !(field in node)) {
    return null;
  }
  return (node as Record<string, unknown>)[field];
};

const isComputed = (node: unknown): boolean =>
  getField(node, "computed") === true;

// Leftmost identifier of a member/call chain: `api.v1.documents.get()` and
// `client.send(cmd)` both resolve to their root binding.
const getChainRootName = (node: unknown): string | null => {
  const current = unwrapExpression(node);
  const type = getType(current);
  if (type === "CallExpression") {
    return getChainRootName(getField(current, "callee"));
  }
  if (type === "MemberExpression" && !isComputed(current)) {
    return getChainRootName(getField(current, "object"));
  }
  return isIdentifier(current) ? current.name : null;
};

const isGlobalFetchCallee = (callee: unknown): boolean => {
  if (isIdentifier(callee, "fetch")) {
    return true;
  }
  if (getType(callee) !== "MemberExpression" || isComputed(callee)) {
    return false;
  }
  const objectName = getChainRootName(getField(callee, "object"));
  return (
    objectName !== null &&
    GLOBAL_FETCH_OBJECTS.has(objectName) &&
    getPropertyName(getField(callee, "property")) === "fetch"
  );
};

// `<anything>.send(new SomeCommand(...))` — the AWS SDK dispatch shape.
const isAwsCommandSend = (node: unknown): boolean => {
  const callee = getField(node, "callee");
  if (
    getType(callee) !== "MemberExpression" ||
    isComputed(callee) ||
    getPropertyName(getField(callee, "property")) !== "send"
  ) {
    return false;
  }
  const args = getField(node, "arguments");
  if (!Array.isArray(args) || args.length === 0) {
    return false;
  }
  const first = unwrapExpression(args[0]);
  if (getType(first) !== "NewExpression") {
    return false;
  }
  const constructorName = getChainRootName(getField(first, "callee"));
  return constructorName !== null && constructorName.endsWith("Command");
};

const isClientModuleSource = (source: string): boolean =>
  CLIENT_MODULES.has(source) || source.startsWith(CLIENT_MODULE_PREFIX);

// Walk up from an awaited expression to the first loop body or function
// boundary. Returns true only for a loop the await runs once per iteration
// of.
const isInsideLoopBody = (node: unknown): boolean => {
  let child = node;
  let current = getField(node, "parent");

  while (current !== null && current !== undefined) {
    const type = getType(current);
    if (type !== null && LOOP_TYPES.has(type)) {
      if (getField(current, "body") === child) {
        return true;
      }
    } else if (type !== null && FUNCTION_TYPES.has(type)) {
      return false;
    }
    child = current;
    current = getField(current, "parent");
  }
  return false;
};

// `Result.await(<expression>)`, the Result-boundary spelling of an await.
const getResultAwaitArgument = (node: unknown): unknown => {
  if (getType(node) !== "CallExpression") {
    return null;
  }
  const callee = getField(node, "callee");
  if (
    getType(callee) !== "MemberExpression" ||
    isComputed(callee) ||
    !isIdentifier(getField(callee, "object"), "Result") ||
    getPropertyName(getField(callee, "property")) !== "await"
  ) {
    return null;
  }
  const args = getField(node, "arguments");
  return Array.isArray(args) && args.length === 1
    ? unwrapExpression(args[0])
    : null;
};

export default eslintCompatPlugin({
  meta: { name: "no-network-await-in-loop" },
  rules: {
    "no-network-await-in-loop": {
      meta: {
        type: "problem",
        messages: {
          noNetworkAwaitInLoop:
            "Network call awaited inside a loop pays one round-trip per " +
            "iteration and grows with the input. Batch with `Promise.all` " +
            "or `Promise.allSettled` under a concurrency cap, or say why " +
            "the sequence is required in a suppression reason.",
        },
      },
      createOnce(context) {
        const fetchBindings = new Set<string>();
        const clientBindings = new Set<string>();

        const isNetworkCall = (node: unknown): boolean => {
          if (getType(node) !== "CallExpression") {
            return false;
          }
          if (isGlobalFetchCallee(getField(node, "callee"))) {
            return true;
          }
          if (isAwsCommandSend(node)) {
            return true;
          }
          const root = getChainRootName(node);
          return (
            root !== null &&
            (fetchBindings.has(root) || clientBindings.has(root))
          );
        };

        const reportAwaitedExpression = (
          node: ESTree.AwaitExpression | ESTree.YieldExpression,
          argument: unknown,
        ): void => {
          if (isNetworkCall(argument) && isInsideLoopBody(node)) {
            context.report({ node, messageId: "noNetworkAwaitInLoop" });
          }
        };

        return {
          before() {
            fetchBindings.clear();
            clientBindings.clear();
            return true;
          },
          ImportDeclaration(node) {
            const source = getField(node, "source");
            if (!isStringLiteral(source)) {
              return;
            }
            const bindings = FETCH_MODULES.has(source.value)
              ? fetchBindings
              : isClientModuleSource(source.value)
                ? clientBindings
                : null;
            if (bindings === null) {
              return;
            }
            const specifiers = getField(node, "specifiers");
            if (!Array.isArray(specifiers)) {
              return;
            }
            for (const specifier of specifiers) {
              const localName =
                getImportLocalName(specifier) ??
                (isIdentifier(getField(specifier, "local"))
                  ? getPropertyName(getField(specifier, "local"))
                  : null);
              if (localName !== null) {
                bindings.add(localName);
              }
            }
          },
          AwaitExpression(node) {
            reportAwaitedExpression(node, unwrapExpression(node.argument));
          },
          YieldExpression(node) {
            if (getField(node, "delegate") !== true) {
              return;
            }
            const resultAwaitArgument = getResultAwaitArgument(
              unwrapExpression(getField(node, "argument")),
            );
            if (resultAwaitArgument !== null) {
              reportAwaitedExpression(node, resultAwaitArgument);
            }
          },
        };
      },
    },
  },
});
