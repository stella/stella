// Two UX conventions that were prose until now, expressed over Tailwind class
// strings (`.agents/skills/conventions-ux/SKILL.md`).
//
// Interactions & Animations: `transition: all` repaints properties nobody chose
// to animate, and `width`/`height`/`top`/`left`/`right`/`bottom`/`inset`/
// `margin`/`padding`/`flex-basis`/`font-size` force a layout recalc on every
// frame. Transform and opacity do not. UI motion also stays short and
// responsive: `ease-in` starts slowly, so a surface feels late to react; an
// entry from `scale-0` reads as appearing from nowhere; a transition longer than
// 300ms makes people wait for the interface.
//
// Viewport & Responsive: `h-screen`/`w-screen` and arbitrary `vh` values
// (`max-h-[calc(100vh-3rem)]`) resolve against the largest viewport, which
// ignores mobile browser chrome and leaves the page scrolled or overlapped.
// The dynamic and small viewport units (`dvh`, `svh`) track it.
//
// Touch reveal: a hover-only affordance stays visible on touch screens through
// the `pointer-coarse:` variant. The `hover: none` media query (written as
// `[@media(hover:none)]:`) is the competing spelling; it also matches a stylus
// without hover on a fine pointer, which is not the intent.
//
// Flagged:
//   <div className="transition-all duration-150" />
//   <div className="opacity-0 [@media(hover:none)]:opacity-100" /> -> pointer-coarse:
//   <div className="transition-[height] md:transition-[top]" />
//   <div className={cn("min-h-screen", className)} />        → min-h-dvh
//   <div className="max-h-[70vh]" />
//   <div className="ease-in duration-500 data-starting-style:scale-0" />
// Allowed:
//   transition-opacity, transition-transform
//   min-h-dvh, h-dvh, max-h-dvh, w-dvw, max-h-[70dvh], pt-[8svh]
//   ease-out, ease-in-out, duration-300, data-starting-style:scale-95
//   animate-[pulse_700ms_ease-in-out_3]
//
// A surface that changes its own box is the documented exemption: a disclosure
// panel, a collapsible rail, a popup positioner repositioning on collision, or a
// progress bar may transition the box property it owns, because a transform
// moves the paint but not what siblings lay out against. Those files are named
// in the `allowedFiles` option with the exact utilities and a reason each. The
// same list carries the motion that is not interface feedback (a decorative
// fade, a teaching animation, marketing motion), which may run longer. The
// exemption covers only those exact utilities: `transition-all`, viewport
// units, and any new spelling in the same file stay reported.
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
  /(^|[^a-z])(width|height|top|left|right|bottom|inset|margin|padding|flex-basis|font-size)([^a-z]|$)/u;

// Maps rather than object literals: the lookup key is an arbitrary token out of
// a source string, and `"constructor" in {}` or `record["__proto__"]` answers
// for `Object.prototype` instead of for this table.
const VIEWPORT_REPLACEMENTS: ReadonlyMap<string, string> = new Map([
  ["h-screen", "h-dvh"],
  ["max-h-screen", "max-h-dvh"],
  ["min-h-screen", "min-h-dvh"],
  ["w-screen", "w-dvw"],
]);

const FIXABLE_UTILITIES = VIEWPORT_REPLACEMENTS;

// A `vh` length inside an arbitrary value. The digit immediately before the
// unit is what separates it from `dvh`/`svh`/`lvh`; the lookahead keeps
// `vhx`-style identifiers out.
const LARGE_VIEWPORT_HEIGHT = /\dvh(?![a-z])/u;

// Above this, a UI transition makes people wait for the interface.
const MAX_UI_DURATION_MS = 300;
const DURATION_UTILITY =
  /^duration-(?:(\d+)|\[(\d+(?:\.\d+)?|\.\d+)(ms|s)\])$/u;

const durationMs = (utility: string): number | undefined => {
  const match = DURATION_UTILITY.exec(utility);
  if (match === null) {
    return undefined;
  }
  const [, scale, value, unit] = match;
  if (scale !== undefined) {
    return Number(scale);
  }
  return unit === "s" ? Number(value) * 1000 : Number(value);
};

// `scale-0` and its axis forms, plus the arbitrary zero spellings.
const SCALE_FROM_ZERO = /^-?scale-(?:[xy]-)?(?:0|\[0(?:\.0+)?\])$/u;

// `hover: none` / `any-hover: none` in any spelling, including inside an
// arbitrary `[@media(...)]` variant, where whitespace is written as `_`.
const HOVER_NONE = /hover_*:_*none(?![a-z-])/u;

// The one spelling with a provable equivalent; any other is reported only.
const HOVER_NONE_VARIANT = "[@media(hover:none)]:";
const TOUCH_VARIANT = "pointer-coarse:";

type MessageId =
  | "easeIn"
  | "hoverNone"
  | "layoutTransition"
  | "longDuration"
  | "scaleFromZero"
  | "transitionAll"
  | "viewportUnit";

// Message ids an `allowedFiles` entry may exempt by exact utility. A
// `transition-all` or a viewport unit is never a property of the surface.
const ALLOWABLE_MESSAGE_IDS: ReadonlySet<MessageId> = new Set([
  "easeIn",
  "layoutTransition",
  "longDuration",
  "scaleFromZero",
]);

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

const filenameOf = (context): string =>
  context.filename ?? context.getFilename?.() ?? "";

// Each entry needs exact utilities and a reason. An existing box-owning motion
// may remain without granting every future layout transition in the same file.
const allowedUtilitiesFor = (context, options): ReadonlySet<string> => {
  const allowedFiles =
    typeof options === "object" &&
    options !== null &&
    !Array.isArray(options) &&
    Array.isArray(options.allowedFiles)
      ? options.allowedFiles
      : [];
  const filename = filenameOf(context);
  const allowedUtilities = allowedFiles.flatMap((allowedFile) => {
    const matches =
      typeof allowedFile === "object" &&
      allowedFile !== null &&
      typeof allowedFile.path === "string" &&
      typeof allowedFile.reason === "string" &&
      allowedFile.reason.trim() !== "" &&
      Array.isArray(allowedFile.utilities) &&
      filename.endsWith(allowedFile.path);
    return matches
      ? allowedFile.utilities.filter(
          (utility) => typeof utility === "string" && utility !== "",
        )
      : [];
  });
  return new Set(allowedUtilities);
};

const messageIdForUtility = (utility: string): MessageId | undefined => {
  if (utility === "transition-all") {
    return "transitionAll";
  }
  if (VIEWPORT_REPLACEMENTS.has(utility)) {
    return "viewportUnit";
  }
  if (LARGE_VIEWPORT_HEIGHT.test(utility)) {
    return "viewportUnit";
  }
  if (utility === "ease-in") {
    return "easeIn";
  }
  if (SCALE_FROM_ZERO.test(utility)) {
    return "scaleFromZero";
  }
  const duration = durationMs(utility);
  if (duration !== undefined) {
    return duration > MAX_UI_DURATION_MS ? "longDuration" : undefined;
  }
  if (!LAYOUT_PROPERTY.test(utility)) {
    return undefined;
  }
  if (utility.startsWith("transition-")) {
    return "layoutTransition";
  }
  return undefined;
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
  allowedUtilities: ReadonlySet<string>,
): MessageId | undefined => {
  if (HOVER_NONE.test(value)) {
    return "hoverNone";
  }
  for (const token of value.split(SPLIT)) {
    if (token === "") {
      continue;
    }
    const { utility } = utilityParts(token);
    const messageId = messageIdForUtility(utility);
    if (messageId === undefined) {
      continue;
    }
    if (ALLOWABLE_MESSAGE_IDS.has(messageId) && allowedUtilities.has(utility)) {
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
  source
    .replaceAll(HOVER_NONE_VARIANT, () => TOUCH_VARIANT)
    .replaceAll(/[^\s"'`{}()]+/gu, rewriteToken);

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
                    reason: { type: "string", minLength: 1 },
                    utilities: {
                      type: "array",
                      items: { type: "string", minLength: 1 },
                      minItems: 1,
                      uniqueItems: true,
                    },
                  },
                  required: ["path", "reason", "utilities"],
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        ],
        messages: {
          easeIn:
            "conventions-ux (Interactions & Animations): never use `ease-in` " +
            "for UI; it starts slowly, so the interface feels late to react. " +
            "Entering and exiting surfaces use ease-out; movement on screen " +
            "uses ease-in-out.",
          longDuration:
            "conventions-ux (Interactions & Animations): UI transitions stay " +
            "at or under 300ms (press 100-160ms, tooltip and small popover " +
            "125-200ms, dropdown 150-250ms, dialog and sheet up to 300ms). " +
            "Decorative or teaching motion that is not interface feedback " +
            "goes in the rule's allowedFiles with a reason.",
          scaleFromZero:
            "conventions-ux (Interactions & Animations): never enter or exit " +
            "from `scale-0`; nothing in the real world appears from a point. " +
            "Start near full size with opacity 0 (scale-95 or scale-98 with " +
            "opacity-0), scaled from the trigger with origin-(--transform-origin).",
          hoverNone:
            "conventions-ux (Interactions & Animations): keep hover-only " +
            "affordances visible on touch with the `pointer-coarse:` variant " +
            "(for example `pointer-coarse:opacity-100`), not a " +
            "`hover: none` media query.",
          layoutTransition:
            "conventions-ux (Interactions & Animations): animate transform " +
            "and opacity only. This transition names a layout property " +
            "(width, height, top, left, right, bottom, inset, margin, " +
            "padding, flex-basis, font-size), which forces a layout recalc " +
            "on every frame. Use scale/translate instead.",
          transitionAll:
            "conventions-ux (Interactions & Animations): never transition " +
            "`all`; it repaints properties nobody chose to animate. Use " +
            "an exact compositable property: transition-opacity or " +
            "transition-transform.",
          viewportUnit:
            "conventions-ux (Viewport & Responsive): `h-screen`/`w-screen` " +
            "and `vh` lengths resolve against the largest viewport and " +
            "ignore mobile browser chrome, which causes scroll and overlap " +
            "bugs. Use the dynamic-viewport units: min-h-dvh, h-dvh, " +
            "max-h-dvh, w-dvw, and dvh (or svh for a length that must not " +
            "move while the toolbar collapses) inside arbitrary values.",
        },
      },
      createOnce(context) {
        let allowedUtilities: ReadonlySet<string> = new Set();

        return {
          before() {
            allowedUtilities = allowedUtilitiesFor(
              context,
              context.options.at(0),
            );
            return true;
          },
          Literal(node) {
            if (typeof node.value !== "string") {
              return;
            }
            const messageId = messageIdIn(node.value, allowedUtilities);
            if (messageId !== undefined) {
              report(context, node, messageId);
            }
          },
          TemplateElement(node) {
            const messageId = messageIdIn(node.value.raw, allowedUtilities);
            if (messageId !== undefined) {
              report(context, node, messageId);
            }
          },
        };
      },
    },
  },
});
