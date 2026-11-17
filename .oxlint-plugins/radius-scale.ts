// Corner radii come from one scale: Tailwind's 4, 6, 8, 12 and 16px steps,
// named `rounded-sm` through `rounded-2xl`. DESIGN.md, Border Radius, maps
// each step to the elements that use it.
//
// Invariant: every radius in `apps/web` and the design-system packages names
// a scale step, so two controls of the same kind cannot differ by a pixel.
//
// Rejected:
//   bare `rounded` and its side forms (`rounded-t`, `rounded-ss`): the same
//   4px as `rounded-sm` under a second spelling, so a search for the step
//   misses half its uses.
//   an arbitrary literal length (`rounded-[7px]`, `rounded-s-[0.6rem]`): a
//   radius between steps.
//
// Accepted:
//   every named step, `rounded-none` and `rounded-full`.
//   an arbitrary value derived from a token (`rounded-[calc(var(--radius-lg)-1px)]`
//   for an inner layer one border width in, `rounded-[inherit]`).
//
// `shadcn/no-arbitrary-values` also reports literal radii in app code, but it
// is off in `packages/ui/src/components`, where the design system needs
// structural arbitrary values; this rule holds the radius scale there too.
//
// Analysis boundary: every string literal and template chunk in a scoped file
// is tokenized, so a utility in a `cn()` argument or a variant map is read like
// one written on the element, and a string that merely spells `rounded` as a
// word is read as the utility.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { classBaseName, classTokens } from "./utils.ts";

const SIDES = [
  "t",
  "b",
  "s",
  "e",
  "l",
  "r",
  "ss",
  "se",
  "es",
  "ee",
  "tl",
  "tr",
  "bl",
  "br",
] as const;

const BARE_RADII = new Set([
  "rounded",
  ...SIDES.map((side) => `rounded-${side}`),
]);

const LITERAL_LENGTH = /^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?[a-z]+$/iu;

const isOffScaleRadius = (utility: string): boolean => {
  if (!utility.startsWith("rounded") || !utility.endsWith("]")) {
    return false;
  }
  const open = utility.indexOf("-[");
  return open !== -1 && LITERAL_LENGTH.test(utility.slice(open + 2, -1).trim());
};

type Finding = "bareRadius" | "offScaleRadius";

const findingFor = (value: string): Finding | undefined => {
  for (const token of classTokens(value)) {
    const utility = classBaseName(token);
    if (BARE_RADII.has(utility)) {
      return "bareRadius";
    }
    if (isOffScaleRadius(utility)) {
      return "offScaleRadius";
    }
  }
  return undefined;
};

export default eslintCompatPlugin({
  meta: { name: "radius-scale" },
  rules: {
    "radius-scale": {
      meta: {
        type: "problem",
        messages: {
          bareRadius:
            "Name the radius step: bare `rounded` (and `rounded-t`, " +
            "`rounded-ss`, ...) is the 4px `rounded-sm` under a second " +
            "spelling. Write `rounded-sm`, or the side form `rounded-t-sm`.",
          offScaleRadius:
            "Corner radii come from the scale (sm 4px, md 6px, lg 8px, xl " +
            "12px, 2xl 16px); DESIGN.md, Border Radius, maps each step to the " +
            "elements that use it. Snap to the nearest step, or derive an inner " +
            "layer from a token: `rounded-[calc(var(--radius-lg)-1px)]`.",
        },
      },
      createOnce(context) {
        return {
          Literal(node) {
            if (typeof node.value !== "string") {
              return;
            }
            const messageId = findingFor(node.value);
            if (messageId !== undefined) {
              context.report({ node, messageId });
            }
          },
          TemplateElement(node) {
            const messageId = findingFor(node.value.raw);
            if (messageId !== undefined) {
              context.report({ node, messageId });
            }
          },
        };
      },
    },
  },
});
