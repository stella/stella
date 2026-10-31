// One way to cut text short (`.agents/skills/conventions-ux/SKILL.md`, Lists,
// Settings Pages & Search): `<TruncatedText>` from `@stll/ui/truncated-text`.
//
// A raw `truncate` only ellipsizes when something else caps the element's
// width. In a parent that does not stretch it (a flex column with
// `items-start`, an inline-block, a `w-fit` chip) a nowrap line sizes to its
// whole text and runs past its container. `<TruncatedText>` adds `min-w-0
// max-w-full`, so the text stops at its container wherever it sits, and shows
// the cut text in a tooltip (a popover on touch) only when it was actually cut.
// `lines` clamps to several lines, `render` keeps the element (`<p />`,
// `<h2 />`, `<BidiText as="span" />`), and `hint={false}` drops the tooltip
// where the surroundings already show the whole text.
//
// Flagged:
//   <span className="truncate text-sm" />          -> <TruncatedText className="text-sm">
//   <p className="line-clamp-2" />                 -> <TruncatedText lines={2} render={<p />}>
//   <div className={cn("sm:truncate", className)} />
//   <div className="[&>span]:truncate" />
//   <span className="overflow-hidden text-ellipsis whitespace-nowrap" />
//   <span className="line-clamp-[7]" />
// Allowed:
//   line-clamp-none, text-clip
//
// The components that implement truncation own the raw utilities; they are
// listed once in `OWNER_FILES` below. A primitive that styles text it does not
// render (a child selector over the caller's children, a Base UI part that
// owns its value element) cannot wrap that text in the component. Those files
// are named in the `allowedFiles` option with the exact token (variant prefix
// included) and a reason each, so a new spelling in the same file stays
// reported.
//
// Every class string in the configured scope is checked, not only the
// `className` attribute: these utilities travel through `cn()`/`cva()`/`clsx()`
// arguments, template literals, and variant maps as often as they are written
// on the element. There is no autofix: the repair replaces the element, and
// whether the text needs a hint depends on what surrounds it.

// Extension is required, not stylistic: plugin sources load under Node's ESM
// resolver as well as Bun's, and Node does not infer one.
import { eslintCompatPlugin } from "@oxlint/plugins";

// Class strings arrive as one attribute, a template, or a helper argument;
// splitting on whitespace and the punctuation around interpolations leaves the
// bare utilities, with arbitrary-value brackets intact.
const SPLIT = /[\s"'`{}()]+/u;

// `line-clamp-<n>` and the arbitrary `line-clamp-[...]`; `line-clamp-none`
// removes a clamp and stays allowed.
const LINE_CLAMP = /^line-clamp-(?:\d+|\[[^\]]+\])$/u;

const isTruncatingUtility = (utility: string): boolean =>
  utility === "truncate" ||
  utility === "text-ellipsis" ||
  LINE_CLAMP.test(utility);

type TokenParts = {
  /** The token without its `!` modifiers: variant prefix plus utility. */
  token: string;
  utility: string;
};

/**
 * A Tailwind token split at its variant prefix, with the `!` modifiers
 * dropped. The variant boundary is the last `:`, which keeps arbitrary
 * variants (`[&>span:last-child]:truncate`) on the prefix side.
 */
const tokenParts = (token: string): TokenParts => {
  const lastVariant = token.lastIndexOf(":");
  const variants = token.slice(0, lastVariant + 1);
  const bare = token.slice(lastVariant + 1);
  const withoutLeading = bare.startsWith("!") ? bare.slice(1) : bare;
  const utility = withoutLeading.endsWith("!")
    ? withoutLeading.slice(0, -1)
    : withoutLeading;
  return { token: `${variants}${utility}`, utility };
};

const filenameOf = (context): string =>
  context.filename ?? context.getFilename?.() ?? "";

// The components that implement truncation, and so own the raw utilities.
// Every other file cuts text through one of them. A new truncating component
// joins this list; a primitive that only styles its caller's text goes in the
// `allowedFiles` option instead, with the exact token and a reason.
const OWNER_FILES: readonly string[] = [
  "packages/ui/src/components/truncated-text.tsx",
];

const isOwnerFile = (filename: string): boolean =>
  OWNER_FILES.some((owner) => filename.endsWith(owner));

// Each entry needs exact tokens and a reason. A primitive that styles its
// caller's text may keep that selector without granting every future
// truncation in the same file.
const allowedTokensFor = (context, options): ReadonlySet<string> => {
  const allowedFiles =
    typeof options === "object" &&
    options !== null &&
    !Array.isArray(options) &&
    Array.isArray(options.allowedFiles)
      ? options.allowedFiles
      : [];
  const filename = filenameOf(context);
  const allowedTokens = allowedFiles.flatMap((allowedFile) => {
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
  return new Set(allowedTokens);
};

/**
 * Whether a string holds a truncating utility that is not exempt.
 *
 * One diagnostic per string rather than one per utility: the repair replaces
 * the element that carries the whole string.
 */
const truncates = (
  value: string,
  allowedTokens: ReadonlySet<string>,
): boolean =>
  value.split(SPLIT).some((raw) => {
    if (raw === "") {
      return false;
    }
    const { token, utility } = tokenParts(raw);
    return isTruncatingUtility(utility) && !allowedTokens.has(token);
  });

export default eslintCompatPlugin({
  meta: { name: "require-truncated-text" },
  rules: {
    "require-truncated-text": {
      meta: {
        type: "problem",
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
          rawTruncation:
            "conventions-ux (Lists, Settings Pages & Search): cut text short " +
            "with `<TruncatedText>` from `@stll/ui/truncated-text`, not " +
            "`truncate`, `text-ellipsis` or `line-clamp-*`. It caps the text " +
            "at its container even where the parent does not stretch it, and " +
            "shows the cut text on hover, focus or tap. Use `lines` for a " +
            "clamp, `render` to keep the element (`render={<p />}`), and " +
            "`hint={false}` where the surroundings already show the text.",
        },
      },
      createOnce(context) {
        let allowedTokens: ReadonlySet<string> = new Set();

        return {
          before() {
            if (isOwnerFile(filenameOf(context))) {
              return false;
            }
            allowedTokens = allowedTokensFor(context, context.options.at(0));
            return true;
          },
          Literal(node) {
            if (
              typeof node.value === "string" &&
              truncates(node.value, allowedTokens)
            ) {
              context.report({ node, messageId: "rawTruncation" });
            }
          },
          TemplateElement(node) {
            if (truncates(node.value.raw, allowedTokens)) {
              context.report({ node, messageId: "rawTruncation" });
            }
          },
        };
      },
    },
  },
});
