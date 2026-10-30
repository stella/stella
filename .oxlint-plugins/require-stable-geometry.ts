/**
 * Geometry specs must use the stable-geometry owner before reading layout.
 * This syntax guard rejects the three browser APIs that previously let specs
 * reintroduce timing, viewport, and direct Playwright-box nondeterminism.
 */
import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, getPropertyName, isAstNode } from "./utils.ts";

const BANNED = new Set(["boundingBox", "setViewportSize", "waitForTimeout"]);

export default eslintCompatPlugin({
  meta: { name: "require-stable-geometry" },
  rules: {
    "require-stable-geometry": {
      meta: {
        type: "problem",
        messages: {
          useHelper:
            "Use apps/web/e2e/helpers/stable-geometry.ts for deterministic geometry measurement.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const filename = filenameForContext(context);
            if (
              !filename.endsWith(".geometry.spec.ts") &&
              !filename.endsWith("-geometry.spec.ts") &&
              !filename.endsWith(
                "/__fixtures__/require-stable-geometry.fixture.ts",
              )
            ) {
              return;
            }
            if (
              isAstNode(node.callee) &&
              node.callee.type === "MemberExpression" &&
              BANNED.has(getPropertyName(node.callee.property) ?? "")
            ) {
              context.report({ node, messageId: "useHelper" });
            }
          },
        };
      },
    },
  },
});
