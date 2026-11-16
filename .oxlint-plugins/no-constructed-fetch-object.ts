// The mobile app must not build its own fetch `Response` or `Request`.
//
// On React Native the global `Response` and `Request` are the `whatwg-fetch`
// polyfill, not the platform classes. That polyfill cannot take a
// `ReadableStream` body: it stores it as the text "[object ReadableStream]",
// so a response rebuilt around the platform's stream reads as garbage on the
// phone while Bun's tests, which have the real classes, pass. Use the response
// the app's `fetch` returned (wrap it, never rebuild it), or pass plain data.
//
// The rule proves one local property: no `Response` or `Request` is
// constructed from the global class, whether named bare or read off
// `globalThis`, `global`, `self` or `window`, and no `Response` comes from a
// static factory (`Response.json`, `Response.error`, `Response.redirect`). A
// shadowed `Response` (an imported or local class) is someone else's and is
// allowed. The production config scopes it to the app's source; tests build
// responses to stub `fetch` and stay out of scope.
//
// Flags:
//   return new Response(body, { status: response.status });
//   new globalThis.Request(url, init);
//   Response.json({ ok: true });
//
// Allows:
//   const response = await fetch(url);
//   return response;
//   const { Response } = makeStub(); new Response();

import type { Context } from "@oxlint/plugins";
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isUnshadowedGlobalIdentifier,
  memberPropertyName,
  unwrapExpression,
} from "./utils.ts";

const FETCH_CLASSES = new Set(["Response", "Request"]);
const GLOBAL_OBJECT_NAMES = new Set(["globalThis", "global", "self", "window"]);
const RESPONSE_FACTORIES = new Set(["json", "error", "redirect"]);

const MESSAGE =
  "Do not construct a fetch Response or Request in the mobile app. On React " +
  "Native these globals are the whatwg-fetch polyfill, which cannot take a " +
  'ReadableStream body and reads it as the text "[object ReadableStream]". ' +
  "Use the response the app's fetch returned (wrap it, do not rebuild it), " +
  "or pass plain data.";

/** The global fetch class `value` names, or null for anything else. */
const globalFetchClass = (context: Context, value: unknown): string | null => {
  const node = unwrapExpression(value);
  if (node === null) {
    return null;
  }
  if (node.type === "Identifier") {
    const name = getPropertyName(node);
    return name !== null &&
      FETCH_CLASSES.has(name) &&
      isUnshadowedGlobalIdentifier(context, node)
      ? name
      : null;
  }
  if (node.type !== "MemberExpression" || !isAstNode(node.object)) {
    return null;
  }
  const name = memberPropertyName(node);
  const base = unwrapExpression(node.object);
  return name !== null &&
    FETCH_CLASSES.has(name) &&
    base !== null &&
    GLOBAL_OBJECT_NAMES.has(getPropertyName(base) ?? "") &&
    isUnshadowedGlobalIdentifier(context, base)
    ? name
    : null;
};

export default eslintCompatPlugin({
  meta: { name: "no-constructed-fetch-object" },
  rules: {
    "no-constructed-fetch-object": {
      meta: {
        type: "problem",
        messages: { constructed: MESSAGE },
        schema: [],
      },
      createOnce(context) {
        return {
          NewExpression(node) {
            if (globalFetchClass(context, node.callee) !== null) {
              context.report({ node, messageId: "constructed" });
            }
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              callee?.type !== "MemberExpression" ||
              !RESPONSE_FACTORIES.has(memberPropertyName(callee) ?? "") ||
              globalFetchClass(context, callee.object) !== "Response"
            ) {
              return;
            }
            context.report({ node, messageId: "constructed" });
          },
        };
      },
    },
  },
});
