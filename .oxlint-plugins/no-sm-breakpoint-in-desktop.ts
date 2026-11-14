// The desktop build starts the `sm` breakpoint at zero
// (apps/desktop/src/mainview/index.css): its windows are narrower than `sm`
// yet always driven by a pointer, so the design system's pointer sizes have
// to apply in all of them. In desktop source `sm:` therefore means "always"
// and `max-sm:` means "never". A layout that follows the window's width
// names that width (`min-[40rem]:`, `max-[40rem]:`) instead.
//
// One `sm:` stays meaningful: pinning a design-system size at every width by
// writing the same utility bare and under `sm:` (`text-base sm:text-base`),
// which the design system's own `sm:` would otherwise override.
//
// Every string is checked, not only `className`: utilities travel through
// `cn()`/`cva()` arguments, template literals and variant maps.
//
// Flagged:
//   <div className="grid sm:grid-cols-3" />
//   <p className={cn("max-sm:hidden", extra)} />
// Allowed:
//   <div className="grid min-[40rem]:grid-cols-3" />
//   <Input className="text-base sm:text-base" />
//
// Scoped by the config's file globs to apps/desktop/src.

import { eslintCompatPlugin } from "@oxlint/plugins";

const SPLIT = /[\s"'`{}()]+/u;

/** A token's variants and utility, without the `!` important marker. */
const parts = (token: string) => {
  const bare = token.replace(/^!|!$/gu, "");
  const variants = bare.split(":");
  const utility = variants.pop() ?? "";
  return { utility, variants };
};

const bannedVariants = (value: string): string[] => {
  if (!value.includes("sm:")) {
    return [];
  }
  const tokens = value.split(SPLIT).filter((token) => token !== "");
  const pinned = new Set(
    tokens
      .map(parts)
      .filter(({ variants }) => variants.length === 0)
      .map(({ utility }) => utility),
  );
  return tokens.filter((token) => {
    const { utility, variants } = parts(token);
    if (utility === "") {
      return false;
    }
    if (variants.includes("max-sm")) {
      return true;
    }
    if (!variants.includes("sm")) {
      return false;
    }
    return !(
      variants.length === 1 &&
      variants[0] === "sm" &&
      pinned.has(utility)
    );
  });
};

const MESSAGE =
  "Desktop windows start `sm` at zero (apps/desktop/src/mainview/index.css), " +
  "so `sm:` here always applies and `max-sm:` never does. Name the window " +
  "width the layout follows (`min-[40rem]:`, `max-[40rem]:`), or drop the " +
  "variant. Pinning a design-system size (`text-base sm:text-base`) is fine.";

export default eslintCompatPlugin({
  meta: { name: "no-sm-breakpoint-in-desktop" },
  rules: {
    "no-sm-breakpoint-in-desktop": {
      meta: {
        type: "problem",
        messages: { breakpoint: MESSAGE },
      },
      createOnce(context) {
        return {
          Literal(node) {
            if (
              typeof node.value === "string" &&
              bannedVariants(node.value).length > 0
            ) {
              context.report({ node, messageId: "breakpoint" });
            }
          },
          TemplateElement(node) {
            if (bannedVariants(node.value.raw).length > 0) {
              context.report({ node, messageId: "breakpoint" });
            }
          },
        };
      },
    },
  },
});
