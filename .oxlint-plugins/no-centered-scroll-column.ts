// Detect a centered, width-constrained content column that also owns the
// vertical scroll. When `overflow-y-auto`/`overflow-y-scroll` sits on the same
// element as `mx-auto` + `max-w-*`, the scrollbar renders at the narrow
// column's right edge — floating mid-pane — instead of at the content pane's
// edge next to the inspector rail.
//
// Fix: move the overflow to a full-width parent (`flex-1 overflow-y-auto`) and
// keep `mx-auto`/`max-w-*` on an inner content wrapper.
//
// Flagged:
//   <div className="mx-auto w-full max-w-2xl overflow-y-auto p-6">
// Allowed:
//   <div className="flex-1 overflow-y-auto"><div className="mx-auto max-w-2xl">
//   popovers/menus (`absolute`/`fixed`) and self-contained scroll boxes
//   (`max-h-*`) legitimately scroll their own max-w box.

const SPLIT = /[\s"'`{}()]+/;

// Drop Tailwind variant prefixes (sm:, hover:, dark:, group-hover:, etc.).
const baseClass = (token: string): string => {
  const idx = token.lastIndexOf(":");
  return idx === -1 ? token : token.slice(idx + 1);
};

const isVerticalScroll = (c: string): boolean =>
  c === "overflow-auto" ||
  c === "overflow-scroll" ||
  c === "overflow-y-auto" ||
  c === "overflow-y-scroll";

const constrainsWidth = (c: string): boolean =>
  c.startsWith("max-w-") && c !== "max-w-none" && c !== "max-w-full";

const isCenteredScrollColumn = (value: string): boolean => {
  const classes = value.split(SPLIT).filter(Boolean).map(baseClass);

  const hasScroll = classes.some(isVerticalScroll);
  const hasCenter = classes.includes("mx-auto");
  const hasMaxW = classes.some(constrainsWidth);
  if (!(hasScroll && hasCenter && hasMaxW)) {
    return false;
  }

  // Popovers/menus position themselves; self-contained boxes (dialogs,
  // dropdowns) cap their own height. Both legitimately own their scroll.
  const exempt = classes.some(
    (c) => c === "absolute" || c === "fixed" || c.startsWith("max-h-"),
  );
  return !exempt;
};

export default {
  meta: { name: "no-centered-scroll-column" },
  rules: {
    "no-centered-scroll-column": {
      meta: {
        type: "problem",
        messages: {
          centeredScrollColumn:
            "Centered, width-capped column owns the vertical scroll " +
            "(mx-auto + max-w-* + overflow-y-auto/scroll), so the scrollbar " +
            "floats at the column edge instead of the pane edge next to the " +
            "inspector rail. Move overflow to a full-width parent " +
            "(e.g. flex-1 overflow-y-auto) and keep mx-auto/max-w-* on an " +
            "inner content wrapper. (absolute/fixed/max-h-* boxes are exempt.)",
        },
      },
      create(context) {
        return {
          Literal(node) {
            if (typeof node.value !== "string") {
              return;
            }
            if (isCenteredScrollColumn(node.value)) {
              context.report({ node, messageId: "centeredScrollColumn" });
            }
          },
          TemplateElement(node) {
            if (isCenteredScrollColumn(node.value.raw)) {
              context.report({ node, messageId: "centeredScrollColumn" });
            }
          },
        };
      },
    },
  },
};
