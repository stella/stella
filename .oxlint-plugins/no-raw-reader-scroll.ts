// A reader's controls bar floats over the top of its text, so a jump that
// scrolls a block to the top of the scroller lands it behind the bar.
// `scrollReaderToBlock` in `reader-landing.ts` is the one owner of where a jump
// lands; a `scrollTo` with a computed `top` is a second answer to the same
// question, and the five that existed had all forgotten the bar.
//
// Flagged:
//   container.scrollTo({ top: offset, behavior: "instant" });
//   viewport.scrollTo({ top: target.getBoundingClientRect().top });
//   scroller.scrollTo({ top });
//   scroller.scrollTo(0, offset);
// Allowed:
//   scrollReaderToBlock(target, container);
//   scroller.scrollTo({ top: 0, behavior: "instant" });   // the document's start
//   scroller.scrollTop += drift;                          // holding a position
//
// Scoped by the config's file globs to the reader modules; the owner is
// excluded there.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { getPropertyName } from "./utils.ts";

const MESSAGE =
  "A jump in a reader lands below its controls bar: call `scrollReaderToBlock` " +
  "from `@stll/decision-reader/reader-landing` instead of computing a `top`.";

/** The start of the document needs no clearance: nothing sits above it. */
const isDocumentStart = (node: { type: string; value?: unknown }): boolean =>
  node.type === "Literal" && node.value === 0;

export default eslintCompatPlugin({
  meta: { name: "no-raw-reader-scroll" },
  rules: {
    "no-raw-reader-scroll": {
      meta: {
        type: "problem",
        messages: { rawScroll: MESSAGE },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const { callee } = node;
            if (
              callee.type !== "MemberExpression" ||
              callee.computed ||
              getPropertyName(callee.property) !== "scrollTo"
            ) {
              return;
            }
            const [options, top] = node.arguments;
            if (top !== undefined && !isDocumentStart(top)) {
              context.report({ node, messageId: "rawScroll" });
              return;
            }
            if (options?.type !== "ObjectExpression") {
              return;
            }
            for (const property of options.properties) {
              if (
                property.type === "Property" &&
                !property.computed &&
                getPropertyName(property.key) === "top" &&
                !isDocumentStart(property.value)
              ) {
                context.report({ node, messageId: "rawScroll" });
                return;
              }
            }
          },
        };
      },
    },
  },
});
