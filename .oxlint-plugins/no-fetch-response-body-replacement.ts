// The fetch transport must return the exact Response supplied by its fetcher.
// Constructing a Response or script ReadableStream in production transport code
// can replace the native body and make it unreadable to non-native consumers.
// Test files remain free to construct fixtures.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext } from "./utils.ts";

const FETCH_SOURCE = /(?:^|\/)packages\/fetch\/src\//u;
const RULE_FIXTURE =
  /(?:^|\/)\.oxlint-plugins\/__fixtures__\/no-fetch-response-body-replacement\.fixture\.ts$/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const FORBIDDEN_CONSTRUCTORS = new Set(["ReadableStream", "Response"]);

export default eslintCompatPlugin({
  meta: { name: "no-fetch-response-body-replacement" },
  rules: {
    "no-fetch-response-body-replacement": {
      meta: {
        type: "problem",
        messages: {
          preserveBody:
            "Return the fetcher's original Response and enforce deadlines through its request signal; never construct a replacement body.",
        },
      },
      createOnce(context) {
        return {
          NewExpression(node) {
            const filename = filenameForContext(context);
            if (
              ((FETCH_SOURCE.test(filename) && !TEST_FILE.test(filename)) ||
                RULE_FIXTURE.test(filename)) &&
              node.callee.type === "Identifier" &&
              FORBIDDEN_CONSTRUCTORS.has(node.callee.name)
            ) {
              context.report({ node, messageId: "preserveBody" });
            }
          },
        };
      },
    },
  },
});
