// Prefer the runtime's native forms over their Node-era spellings, so Bun
// code rides the runtime's own improvements.
//
// `no-buffer-string-encoding`: `.toString("hex" | "base64" | "base64url")`
// is the Node `Buffer` spelling of byte encoding. The standard
// `Uint8Array.prototype.toHex()` / `toBase64()` encode the same bytes to the
// same text (a `Buffer` is a `Uint8Array`), and are 1.3-4x faster than
// wrapping bytes in a `Buffer` to encode them. A string still converts once
// through `Buffer.from(text)`, which stays Bun's single native UTF-8 pass:
// `Buffer.from(text).toBase64()`. The fix is local and deterministic, so it
// is applied automatically:
//   flagged: bytes.toString("hex")         fixed: bytes.toHex()
//   flagged: bytes.toString("base64")      fixed: bytes.toBase64()
//   flagged: bytes.toString("base64url")
//   fixed:   bytes.toBase64({ alphabet: "base64url", omitPadding: true })
// A string-literal argument only exists on `Buffer#toString`; a number's
// `toString` takes a radix.
//
// `no-headers-from-entries`: `Object.fromEntries(headers.entries())` copies a
// `Headers` through a JavaScript iterator; `headers.toJSON()` builds the same
// lower-cased record natively. Reported, not fixed: `toJSON` keeps
// `set-cookie` as a list where `entries()` joins it, so a site that can see
// one decides.
//   flagged: Object.fromEntries(request.headers.entries())
//   flagged: Object.fromEntries(new Headers(init))
//   accepted: Object.fromEntries(map.entries())

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  isAstNode,
  isIdentifier,
  memberPropertyName,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const NATIVE_ENCODING = {
  hex: "toHex()",
  base64: "toBase64()",
  base64url: 'toBase64({ alphabet: "base64url", omitPadding: true })',
} as const;

const isNativeEncoding = (
  value: string | null,
): value is keyof typeof NATIVE_ENCODING =>
  value !== null && Object.hasOwn(NATIVE_ENCODING, value);

/** `x.headers`, `x.headers.entries()`, `new Headers(...)` or its `entries()`. */
const isHeadersSource = (value: unknown): boolean => {
  const node = unwrapExpression(value);
  if (!isAstNode(node)) {
    return false;
  }
  if (node.type === "NewExpression") {
    return isIdentifier(node.callee, "Headers");
  }
  if (node.type === "MemberExpression") {
    return memberPropertyName(node) === "headers";
  }
  if (node.type === "CallExpression") {
    const callee = unwrapExpression(node.callee);
    return (
      isAstNode(callee) &&
      callee.type === "MemberExpression" &&
      memberPropertyName(callee) === "entries" &&
      Array.isArray(node.arguments) &&
      node.arguments.length === 0 &&
      isHeadersSource(callee.object)
    );
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "prefer-bun-native" },
  rules: {
    "no-buffer-string-encoding": {
      meta: {
        type: "suggestion",
        fixable: "code",
        messages: {
          encode:
            'Encode bytes with `{{native}}` instead of `.toString("{{encoding}}")`; a string converts once with `Buffer.from(text)` first.',
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee.type !== "MemberExpression" ||
              memberPropertyName(callee) !== "toString" ||
              node.arguments.length !== 1
            ) {
              return;
            }
            const encoding = staticStringValue(node.arguments[0]);
            if (!isNativeEncoding(encoding)) {
              return;
            }
            const native = NATIVE_ENCODING[encoding];
            const report = {
              node,
              messageId: "encode",
              data: { native: `.${native}`, encoding },
            } as const;
            // Only `x.toString("…")` is rewritten; a computed key is left for
            // a person to spell.
            if (callee.computed) {
              context.report(report);
              return;
            }
            context.report({
              ...report,
              fix: (fixer) =>
                fixer.replaceTextRange(
                  [callee.property.range[0], node.range[1]],
                  native,
                ),
            });
          },
        };
      },
    },
    "no-headers-from-entries": {
      meta: {
        type: "suggestion",
        messages: {
          toJson:
            "Read a `Headers` as a record with `headers.toJSON()`; it is built natively. Note it keeps `set-cookie` as a list.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              !isAstNode(callee) ||
              callee.type !== "MemberExpression" ||
              !isIdentifier(callee.object, "Object") ||
              memberPropertyName(callee) !== "fromEntries" ||
              node.arguments.length !== 1 ||
              !isHeadersSource(node.arguments[0])
            ) {
              return;
            }
            context.report({ node, messageId: "toJson" });
          },
        };
      },
    },
  },
});
