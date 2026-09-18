// Two UX conventions that were prose until now, expressed over Tailwind class
// strings (`.agents/skills/conventions-ux/SKILL.md`).
//
// Interactions & Animations: `transition: all` repaints properties nobody chose
// to animate, and `width`/`height`/`top`/`left`/`right`/`bottom`/`inset`/
// `margin`/`padding` force a layout recalc on every frame. Compositable
// properties (`transform`, `opacity`, colours, shadows) do not.
//
// Viewport & Responsive: `h-screen`/`w-screen` resolve against `100vh`/`100vw`,
// which ignores mobile browser chrome and leaves the page scrolled or
// overlapped. The dynamic-viewport units track it.
//
// Flagged:
//   <div className="transition-all duration-150" />          → transition
//   <div className="transition-[height] md:transition-[top]" />
//   <div className={cn("min-h-screen", className)} />        → min-h-dvh
//   <div className="animate-[height_200ms] w-screen" />
// Allowed:
//   transition, transition-opacity, transition-transform, transition-colors
//   min-h-dvh, h-dvh, max-h-dvh, w-dvw
//   animate-[pulse_700ms_ease-in-out_3]
//
// A surface that changes its own box is the documented exemption: a disclosure
// panel, a collapsible rail, a popup positioner repositioning on collision, or a
// progress bar may transition the box property it owns, because a transform
// moves the paint but not what siblings lay out against. Those files are named
// in the `allowedFiles` option with a reason each, and the exemption covers only
// the layout-property diagnostics: `transition-all` and the viewport utilities
// stay reported everywhere.
//
// Every class string in the configured scope is checked, not only the
// `className` attribute: these utilities travel through `cn()`/`cva()`/`clsx()`
// arguments, template literals, and variant maps as often as they are written
// on the element. The autofix is confined to strings that are provably class
// names (a direct `className` value or a direct string argument of a class
// composer), so prose is never rewritten.

// Extension is required, not stylistic: plugin sources load under Node's ESM
// resolver as well as Bun's, and Node does not infer one.
import { eslintCompatPlugin } from "@oxlint/plugins";

// Class strings arrive as one attribute, a template, or a helper argument;
// splitting on whitespace and the punctuation around interpolations leaves the
// bare utilities, with arbitrary-value brackets intact.
const SPLIT = /[\s"'`{}()]+/u;

// Applied to a whole utility, so the boundaries are "not a lowercase letter"
// rather than `\b`: Tailwind writes arbitrary values as `transition-[width_150ms]`,
// where `_` is a word character and would defeat `\b`.
const LAYOUT_PROPERTY =
  /(^|[^a-z])(width|height|top|left|right|bottom|inset|margin|padding)([^a-z]|$)/u;

// Maps rather than object literals: the lookup key is an arbitrary token out of
// a source string, and `"constructor" in {}` or `record["__proto__"]` answers
// for `Object.prototype` instead of for this table.
const VIEWPORT_REPLACEMENTS: ReadonlyMap<string, string> = new Map([
  ["h-screen", "h-dvh"],
  ["max-h-screen", "max-h-dvh"],
  ["min-h-screen", "min-h-dvh"],
  ["w-screen", "w-dvw"],
]);

const FIXABLE_UTILITIES: ReadonlyMap<string, string> = new Map([
  ...VIEWPORT_REPLACEMENTS,
  // Tailwind's bare `transition` animates its curated property set, which is
  // what a `transition-all` author almost always meant.
  ["transition-all", "transition"],
]);

type MessageId =
  | "layoutAnimation"
  | "layoutTransition"
  | "transitionAll"
  | "viewportUnit";

type UtilityParts = {
  leadingImportant: boolean;
  trailingImportant: boolean;
  utility: string;
  variants: string;
};

/**
 * A Tailwind token split into its variant prefix, `!` modifiers, and the
 * utility itself. The variant boundary is the last `:`, which keeps arbitrary
 * variants (`supports-[display:grid]:h-screen`) on the prefix side.
 */
const utilityParts = (token: string): UtilityParts => {
  const lastVariant = token.lastIndexOf(":");
  const variants = token.slice(0, lastVariant + 1);
  const bare = token.slice(lastVariant + 1);
  const leadingImportant = bare.startsWith("!");
  const withoutLeading = leadingImportant ? bare.slice(1) : bare;
  const trailingImportant = withoutLeading.endsWith("!");
  return {
    leadingImportant,
    trailingImportant,
    utility: trailingImportant ? withoutLeading.slice(0, -1) : withoutLeading,
    variants,
  };
};

// The two diagnostics a box-owning surface is allowed to keep.
const LAYOUT_MESSAGE_IDS: ReadonlySet<MessageId> = new Set([
  "layoutAnimation",
  "layoutTransition",
]);

const filenameOf = (context): string =>
  context.filename ?? context.getFilename?.() ?? "";

// Each entry needs a reason: the allowance grows only when someone can name the
// surface that owns the box, which is what the convention asks for.
const isAllowedFile = (context, options): boolean => {
  const allowedFiles =
    typeof options === "object" &&
    options !== null &&
    !Array.isArray(options) &&
    Array.isArray(options.allowedFiles)
      ? options.allowedFiles
      : [];
  const filename = filenameOf(context);
  return allowedFiles.some(
    (allowedFile) =>
      typeof allowedFile === "object" &&
      allowedFile !== null &&
      typeof allowedFile.path === "string" &&
      typeof allowedFile.reason === "string" &&
      filename.endsWith(allowedFile.path),
  );
};

const messageIdForUtility = (utility: string): MessageId | undefined => {
  if (utility === "transition-all") {
    return "transitionAll";
  }
  if (VIEWPORT_REPLACEMENTS.has(utility)) {
    return "viewportUnit";
  }
  if (!LAYOUT_PROPERTY.test(utility)) {
    return undefined;
  }
  if (utility.startsWith("transition-")) {
    return "layoutTransition";
  }
  return utility.startsWith("animate-[") ? "layoutAnimation" : undefined;
};

/**
 * The message for the first offending utility in a class string, or undefined.
 *
 * One diagnostic per string rather than one per utility: the repair rewrites
 * every fixable token in a single edit, and a second report over the same range
 * would survive that edit as a stale diagnostic. A string whose remaining
 * violation has no mechanical repair is reported again on the next pass.
 */
const messageIdIn = (
  value: string,
  ownsItsBox: boolean,
): MessageId | undefined => {
  for (const token of value.split(SPLIT)) {
    if (token === "") {
      continue;
    }
    const messageId = messageIdForUtility(utilityParts(token).utility);
    if (messageId === undefined) {
      continue;
    }
    if (ownsItsBox && LAYOUT_MESSAGE_IDS.has(messageId)) {
      continue;
    }
    return messageId;
  }
  return undefined;
};

const rewriteToken = (token: string): string => {
  const { leadingImportant, trailingImportant, utility, variants } =
    utilityParts(token);
  const replacement = FIXABLE_UTILITIES.get(utility);
  if (replacement === undefined) {
    return token;
  }
  return `${variants}${leadingImportant ? "!" : ""}${replacement}${
    trailingImportant ? "!" : ""
  }`;
};

const rewriteClassString = (source: string): string =>
  source.replaceAll(/[^\s"'`{}()]+/gu, rewriteToken);

const isClassNameAttribute = (node) =>
  node?.type === "JSXAttribute" &&
  node.name.type === "JSXIdentifier" &&
  node.name.name === "className";

// `cn`, `cva`, and `clsx` exist to compose class strings, so a direct string
// argument is as provably a class name as a `className` value.
const CLASS_COMPOSERS = new Set(["clsx", "cn", "cva"]);

const isClassComposerArgument = (node) =>
  node.parent?.type === "CallExpression" &&
  node.parent.callee?.type === "Identifier" &&
  CLASS_COMPOSERS.has(node.parent.callee.name) &&
  node.parent.arguments.includes(node);

// Only provable class strings receive a potentially meaning-changing fix.
// Other strings still get the diagnostic.
const isProvableClassString = (node) => {
  if (isClassNameAttribute(node.parent) && node.parent.value === node) {
    return true;
  }
  if (
    node.parent?.type === "JSXExpressionContainer" &&
    node.parent.expression === node &&
    isClassNameAttribute(node.parent.parent)
  ) {
    return true;
  }
  if (node.type !== "TemplateElement") {
    return isClassComposerArgument(node);
  }
  const template = node.parent;
  const container = template?.parent;
  if (template?.type !== "TemplateLiteral") {
    return false;
  }
  // A later quasi may continue an arbitrary bracket payload opened by an
  // interpolation, so its token boundaries are not independently provable.
  if (template.quasis.at(0) !== node) {
    return false;
  }
  return (
    (container?.type === "JSXExpressionContainer" &&
      container.expression === template &&
      isClassNameAttribute(container.parent)) ||
    isClassComposerArgument(template)
  );
};

const report = (context, node, messageId: MessageId) => {
  if (!isProvableClassString(node)) {
    context.report({ node, messageId });
    return;
  }
  context.report({
    node,
    messageId,
    fix: (fixer) => {
      const source = context.sourceCode.getText(node);
      // The rule reads a cooked value while a fixer edits raw source, so an
      // escape or JSX character reference can hide a token boundary from the
      // source scanner. Leave those for a human.
      if (
        source.includes("\\") ||
        /&(?:#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);/iu.test(source)
      ) {
        return null;
      }
      const replacement = rewriteClassString(source);
      return replacement === source
        ? null
        : fixer.replaceText(node, replacement);
    },
  });
};

export default eslintCompatPlugin({
  meta: { name: "no-layout-motion-classes" },
  rules: {
    "no-layout-motion-classes": {
      meta: {
        type: "problem",
        fixable: "code",
        schema: [
          {
            type: "object",
            properties: {
              allowedFiles: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    reason: { type: "string" },
                  },
                  required: ["path", "reason"],
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        ],
        messages: {
          layoutAnimation:
            "conventions-ux (Interactions & Animations): animate transform " +
            "and opacity only. This animation names a layout property " +
            "(width, height, top, left, right, bottom, inset, margin, " +
            "padding), which forces a layout recalc on every frame. Use " +
            "scale/translate instead.",
          layoutTransition:
            "conventions-ux (Interactions & Animations): animate transform " +
            "and opacity only. This transition names a layout property " +
            "(width, height, top, left, right, bottom, inset, margin, " +
            "padding), which forces a layout recalc on every frame. Use " +
            "scale/translate instead.",
          transitionAll:
            "conventions-ux (Interactions & Animations): never transition " +
            "`all`; it repaints properties nobody chose to animate. Use " +
            "`transition` for Tailwind's default property set, or name the " +
            "property: transition-opacity, transition-transform, " +
            "transition-colors, transition-shadow.",
          viewportUnit:
            "conventions-ux (Viewport & Responsive): `h-screen`/`w-screen` " +
            "resolve against 100vh/100vw and ignore mobile browser chrome, " +
            "which causes scroll and overlap bugs. Use the dynamic-viewport " +
            "units: min-h-dvh, h-dvh, max-h-dvh, w-dvw.",
        },
      },
      createOnce(context) {
        let ownsItsBox = false;

        return {
          before() {
            ownsItsBox = isAllowedFile(context, context.options?.at(0));
            return true;
          },
          Literal(node) {
            if (typeof node.value !== "string") {
              return;
            }
            const messageId = messageIdIn(node.value, ownsItsBox);
            if (messageId !== undefined) {
              report(context, node, messageId);
            }
          },
          TemplateElement(node) {
            const messageId = messageIdIn(node.value.raw, ownsItsBox);
            if (messageId !== undefined) {
              report(context, node, messageId);
            }
          },
        };
      },
    },
  },
});
