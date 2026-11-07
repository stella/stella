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
//     `@stll/fetch` (packages/fetch), plus the api's other
//     HTTP helpers `@/api/lib/auth/authorized-outbound-fetch` and
//     `@/api/lib/redirect-fetch`. Modules are matched by import source, so a
//     local helper that merely spells `fetchSomething` is not a network call
//     and an aliased import still is.
//   - `client.send(new SomeCommand(...))`: the AWS SDK command dispatch
//     shape. The `new *Command(...)` argument is required, so an unrelated
//     `transport.send(message)` stays out of scope.
//   - A method call on a binding imported from `@aws-sdk/*`,
//     `@stll/api-client`, or the browser client (`@/lib/api`, which exports
//     `api` and `apiClient`), e.g.
//     `await api.documents({ id }).get()`. Computed access is traversed, so a
//     generated hyphenated route (`api["copy-to-workspace"].post(...)`) still
//     resolves to the imported client.
//
// "Inside a loop" walks up `parent` links from the await to the first
// position that re-runs on every iteration: a loop BODY, a `while` / `do`
// test, or a `for` test or update. The one-time positions — a `for`
// initializer and a `for-of` / `for-in` right-hand side — are not per-iteration
// work. The walk stops at the first function boundary, since a network await
// inside a nested function belongs to that function's own call site; a
// `Result.tryPromise` callback is not such a boundary, because it runs where
// it stands.
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

import { createNetworkCallDetector } from "./network-call.ts";
import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isPerIterationLoopPosition,
  isResultTryPromiseCallback,
  LOOP_NODE_TYPES,
  unwrapExpression,
} from "./utils.ts";

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const getType = (node: unknown): string | null =>
  isAstNode(node) ? node.type : null;

const getField = (node: unknown, field: string): unknown => {
  if (typeof node !== "object" || node === null || !(field in node)) {
    return null;
  }
  return Reflect.get(node, field);
};

const isComputed = (node: unknown): boolean =>
  getField(node, "computed") === true;

// Walk up from an awaited expression to the first per-iteration loop position
// or function boundary. A `Result.tryPromise` callback is not a boundary: it
// runs where it stands, so the walk continues through it.
const runsOncePerIteration = (node: unknown): boolean => {
  let child = node;
  let current = getField(node, "parent");

  while (current !== null && current !== undefined) {
    const type = getType(current);
    if (type !== null && LOOP_NODE_TYPES.has(type)) {
      if (isPerIterationLoopPosition(current, child)) {
        return true;
      }
    } else if (
      type !== null &&
      FUNCTION_TYPES.has(type) &&
      !isResultTryPromiseCallback(current)
    ) {
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
        const isNetworkCall = createNetworkCallDetector(context);

        const reportAwaitedExpression = (
          node: ESTree.AwaitExpression | ESTree.YieldExpression,
          argument: unknown,
        ): void => {
          if (isNetworkCall(argument) && runsOncePerIteration(node)) {
            context.report({ node, messageId: "noNetworkAwaitInLoop" });
          }
        };

        return {
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
