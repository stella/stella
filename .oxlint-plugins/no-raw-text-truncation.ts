// Text that does not fit is cut through `TruncatedText`
// (`@stll/ui/truncated-text`), not a raw Tailwind truncation utility. The
// component owns what a cut needs: the ellipsis, the full text on hover or
// focus only when it was actually cut, a popover on tap (touch has no hover),
// no layout reads until someone points at it, and the full text kept for
// screen readers. A raw `truncate` gives the ellipsis and nothing else, so a
// reader can never see the rest.
//
// Invariant: in `apps/web` and `apps/desktop`, every text cut by its box is a
// `TruncatedText` (or another owner listed in TRUNCATION_OWNERS).
//
// Rejected: `truncate`, `text-ellipsis`, and `line-clamp-<n>` (arbitrary
// values included), under any variant prefix (`sm:truncate`,
// `group-hover:line-clamp-2`) or important marker (`!truncate`,
// `truncate!`). Use `<TruncatedText>`: `render` keeps the element type,
// `lines` clamps to two or three lines, and `tooltip` names the full value
// when the visible text is not it.
//
// Accepted: `line-clamp-none`, which lifts a clamp; and `overflow-hidden`,
// `min-w-0`, `text-clip` and the other box utilities a layout wrapper clips
// non-text children with. A wrapper that truly needs a truncation utility on
// non-text content carries an explained
// `oxlint-disable-next-line no-raw-text-truncation/no-raw-text-truncation --
// <reason>` directive, which the suppression budget in `scripts/ratchet.ts`
// charges like every other.
//
// Analysis boundary: this reads class strings, not the DOM. Every string
// literal and template chunk in a scoped file is tokenized, so a utility in a
// `cn()`/`clsx()` argument, a `cva` variant map or a hoisted class constant is
// read like one written on `className`, and a string that merely spells the
// utility is read as one. A boolean prop named `truncate` is not a class and
// is not read.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { classBaseName, classTokens, filenameForContext } from "./utils.ts";

/**
 * The sanctioned owners of text truncation, as repository-relative paths.
 * Only these modules may spell the raw utilities: each one wraps them with the
 * full-text reveal a cut needs. Add an owner here, with the reason it is one,
 * rather than widening the rule's scope or exempting a caller.
 *
 * `MiddleTruncate` (`packages/ui/src/components/middle-truncate.tsx`), which
 * keeps the end of a file name visible, joins this list when it lands.
 */
export const TRUNCATION_OWNERS: readonly string[] = [
  // End truncation and line clamps with the reveal on hover, focus and tap.
  "packages/ui/src/components/truncated-text.tsx",
];

const isTruncationOwner = (filename: string): boolean =>
  TRUNCATION_OWNERS.some(
    (owner) => filename === owner || filename.endsWith(`/${owner}`),
  );

/** The utility a token applies, without its variants or important marker. */
const utilityOf = (token: string): string => {
  const base = classBaseName(token);
  const start = base.startsWith("!") ? 1 : 0;
  const end = base.endsWith("!") ? base.length - 1 : base.length;
  return base.slice(start, end);
};

const LINE_CLAMP_PREFIX = "line-clamp-";

const isRawTruncation = (utility: string): boolean =>
  utility === "truncate" ||
  utility === "text-ellipsis" ||
  (utility.startsWith(LINE_CLAMP_PREFIX) &&
    utility.length > LINE_CLAMP_PREFIX.length &&
    utility !== "line-clamp-none");

export const hasRawTextTruncation = (value: string): boolean =>
  classTokens(value).some((token) => isRawTruncation(utilityOf(token)));

export default eslintCompatPlugin({
  meta: { name: "no-raw-text-truncation" },
  rules: {
    "no-raw-text-truncation": {
      meta: {
        type: "problem",
        messages: {
          rawTextTruncation:
            "Cut text through TruncatedText from @stll/ui/truncated-text, " +
            "not a raw truncate/line-clamp/text-ellipsis utility: the raw " +
            "class hides the rest of the text with no way to read it. " +
            "`render` keeps the element type, `lines` clamps to 2 or 3 " +
            "lines, and `tooltip` names the full value when the visible " +
            "text is not it. A layout wrapper that clips non-text children " +
            "uses overflow-hidden or min-w-0 instead.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            return !isTruncationOwner(filenameForContext(context));
          },
          Literal(node) {
            if (
              typeof node.value === "string" &&
              hasRawTextTruncation(node.value)
            ) {
              context.report({ node, messageId: "rawTextTruncation" });
            }
          },
          TemplateElement(node) {
            if (hasRawTextTruncation(node.value.raw)) {
              context.report({ node, messageId: "rawTextTruncation" });
            }
          },
        };
      },
    },
  },
});
