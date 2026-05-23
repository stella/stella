// Require an AbortSignal on every fetch() call so upstream hangs don't
// hang the request/worker indefinitely.
//
// CLAUDE.md mandates `fetch(url, { signal: AbortSignal.timeout(...) })`
// (or a propagated controller/upstream signal). Without a signal, a
// slow third-party endpoint stalls the entire handler — invisible in
// dev, paging on-call in prod.
//
// Flags:
//   fetch(url)                       // no options at all
//   fetch(url, {})                   // empty options
//   fetch(url, { method: "POST" })   // options without `signal`
//   globalThis.fetch(url, { ... })   // same, via global access
//   window.fetch(url, { ... })
//
// Allows:
//   fetch(url, { signal: AbortSignal.timeout(10_000) })
//   fetch(url, { signal: controller.signal })
//   fetch(url, { signal: req.signal, method: "POST" })
//   fetch(url, opts)                 // opaque variable — can't inspect
//   fetch(url, { ...rest })          // spread may carry signal
//
// Escape hatch: `// eslint-disable-next-line require-fetch-timeout/require-fetch-timeout`
// with a `// SAFETY:` comment explaining why the call cannot hang
// (e.g. local file: URL, in-process Bun.serve handler).

import { getPropertyName, isIdentifier } from "./utils.ts";

const isFetchCallee = (callee: unknown): boolean => {
  if (isIdentifier(callee, "fetch")) {
    return true;
  }
  if (
    typeof callee !== "object" ||
    callee === null ||
    (callee as { type?: unknown }).type !== "MemberExpression"
  ) {
    return false;
  }
  const member = callee as {
    computed?: unknown;
    object?: unknown;
    property?: unknown;
  };
  if (member.computed !== false) {
    return false;
  }
  if (!isIdentifier(member.property, "fetch")) {
    return false;
  }
  return (
    isIdentifier(member.object, "globalThis") ||
    isIdentifier(member.object, "window") ||
    isIdentifier(member.object, "self") ||
    isIdentifier(member.object, "global")
  );
};

// `fetch(new Request(url, { signal }))` carries the signal on the
// Request object, so we can't see it from this side; treat the call
// as opaque rather than false-flagging it.
const isRequestConstructor = (node: unknown): boolean => {
  if (
    typeof node !== "object" ||
    node === null ||
    (node as { type?: unknown }).type !== "NewExpression"
  ) {
    return false;
  }
  return isIdentifier((node as { callee?: unknown }).callee, "Request");
};

const optionsObjectHasSignal = (options: {
  properties: { type: string; key?: unknown }[];
}): "yes" | "no" | "opaque" => {
  for (const prop of options.properties) {
    if (prop.type === "SpreadElement") {
      return "opaque";
    }
    if (prop.type !== "Property") {
      continue;
    }
    if (getPropertyName(prop.key) === "signal") {
      return "yes";
    }
  }
  return "no";
};

export default {
  meta: { name: "require-fetch-timeout" },
  rules: {
    "require-fetch-timeout": {
      meta: {
        type: "problem",
        messages: {
          missingSignal:
            "fetch() must pass `signal` (e.g. " +
            "`{ signal: AbortSignal.timeout(10_000) }`) so upstream " +
            "hangs cannot stall the handler.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isFetchCallee(node.callee)) {
              return;
            }

            const [firstArg, options] = node.arguments;

            if (options === undefined) {
              if (isRequestConstructor(firstArg)) {
                return;
              }
              context.report({ node, messageId: "missingSignal" });
              return;
            }

            if (options.type !== "ObjectExpression") {
              return;
            }

            if (optionsObjectHasSignal(options) === "no") {
              context.report({ node, messageId: "missingSignal" });
            }
          },
        };
      },
    },
  },
};
