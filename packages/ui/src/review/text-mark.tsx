import type { ComponentProps } from "react";

import { cn } from "../lib/utils";

/**
 * One mark for words in running text: a search or find hit, a reader's own
 * highlight, a verdict under a claim. Every surface that points at words
 * draws them this way, so a found word, a note and a finding differ only in
 * hue and line, never in shape.
 *
 * Marks stay inline with no padding or rounding: a mark over several lines or
 * inline runs is several boxes, and only a flat, cloned background reads as
 * one continuous mark. The hue travels as the `--text-mark` custom property,
 * so each variant and state is spelled once and every tone reuses it.
 */

export const TextMark = ({
  variant,
  tone,
  state,
  weight,
  className,
  ...props
}: TextMarkProps) => (
  <mark
    className={cn(textMarkClass({ variant, tone, state, weight }), className)}
    data-slot="text-mark"
    {...props}
  />
);

export type TextMarkVariant =
  | "fill"
  | "underline"
  | "dotted"
  | "wavy"
  | "strike";

export type TextMarkTone =
  | "warning"
  | "success"
  | "destructive"
  | "muted"
  | "option-yellow"
  | "option-green"
  | "option-sky"
  | "option-violet"
  | "option-red"
  | "option-purple";

/**
 * `matched` is a line mark picked out by a filter: it gains a faint wash of
 * its hue. A fill mark is already a wash, so it looks the same at rest and
 * matched. `active` is the one mark being pointed at (the current find hit,
 * the selected claim): a stronger wash of the same hue and a ring of it.
 */
export type TextMarkState = "rest" | "matched" | "active";

/** Search hits read a touch heavier than the words around them. */
export type TextMarkWeight = "inherit" | "medium";

export type TextMarkOptions = {
  variant: TextMarkVariant;
  tone: TextMarkTone;
  state?: TextMarkState;
  weight?: TextMarkWeight;
};

type TextMarkProps = ComponentProps<"mark"> & TextMarkOptions;

/** The CSS value of each tone's hue. */
export const TEXT_MARK_TONE_COLOR = {
  warning: "var(--warning)",
  success: "var(--success)",
  destructive: "var(--destructive)",
  muted: "var(--muted-foreground)",
  "option-yellow": "var(--option-yellow)",
  "option-green": "var(--option-green)",
  "option-sky": "var(--option-sky)",
  "option-violet": "var(--option-violet)",
  "option-red": "var(--option-red)",
  "option-purple": "var(--option-purple)",
} as const satisfies Record<TextMarkTone, string>;

/** How a found word is marked everywhere: readers, snippets, PDFs, tables. */
export const SEARCH_HIT_MARK = {
  variant: "fill",
  tone: "warning",
  weight: "medium",
} as const satisfies TextMarkOptions;

/** The classes of one mark, for markup that is not a `<TextMark>` (a claim
 *  button, a PDF text-layer box, an element a DOM walker creates). */
export const textMarkClass = ({
  variant,
  tone,
  state = "rest",
  weight = "inherit",
}: TextMarkOptions): string =>
  [
    TEXT_MARK_BASE_CLASS,
    VARIANT_CLASS[variant],
    TONE_CLASS[tone],
    WASH_CLASS[variant === "fill" ? "fill" : "line"][state],
    WEIGHT_CLASS[weight],
  ]
    .filter((part) => part !== "")
    .join(" ");

/**
 * The search-hit mark reached through a descendant selector, for markup that
 * arrives already highlighted (the search endpoints' `<mark>` snippets).
 * Spelled out because Tailwind emits only the classes it can read in the
 * source; `text-mark.test.ts` holds it to `textMarkClass(SEARCH_HIT_MARK)`.
 */
export const SEARCH_HIT_DESCENDANT_MARK_CLASS =
  "[&_mark]:box-decoration-clone [&_mark]:text-foreground [&_mark]:[--text-mark:var(--warning)] [&_mark]:bg-(--text-mark)/30 [&_mark]:dark:bg-(--text-mark)/20 [&_mark]:font-medium";

type TextMarkHighlightRuleOptions = {
  /** The registered `CSS.highlights` name. */
  name: string;
  tone: TextMarkTone;
  state: Exclude<TextMarkState, "matched">;
};

/**
 * A fill mark for the CSS Custom Highlight API. `::highlight()` takes colours
 * but no classes, custom properties or rings, so a find that marks ranges
 * rather than elements gets the fill's wash as a rule; the active range is
 * told apart by its stronger wash alone.
 */
export const textMarkHighlightRule = ({
  name,
  tone,
  state,
}: TextMarkHighlightRuleOptions): string => {
  const color = TEXT_MARK_TONE_COLOR[tone];
  const { light, dark } = FILL_PERCENT[state];
  return [
    `::highlight(${name}) { background-color: color-mix(in oklab, ${color} ${light}%, transparent); color: inherit; }`,
    `.dark ::highlight(${name}) { background-color: color-mix(in oklab, ${color} ${dark}%, transparent); }`,
  ].join("\n");
};

const TEXT_MARK_BASE_CLASS = "box-decoration-clone";

const LINE_CLASS =
  "text-inherit underline decoration-2 underline-offset-3 decoration-[color:var(--text-mark)]";

const VARIANT_CLASS = {
  fill: "text-foreground",
  underline: LINE_CLASS,
  dotted: `${LINE_CLASS} decoration-dotted`,
  wavy: `${LINE_CLASS} decoration-wavy`,
  strike:
    "text-inherit line-through decoration-2 decoration-[color:var(--text-mark)]",
} as const satisfies Record<TextMarkVariant, string>;

// Literal per tone rather than built from `TEXT_MARK_TONE_COLOR`: Tailwind
// only generates classes it can read in the source.
const TONE_CLASS = {
  warning: "[--text-mark:var(--warning)]",
  success: "[--text-mark:var(--success)]",
  destructive: "[--text-mark:var(--destructive)]",
  muted: "[--text-mark:var(--muted-foreground)]",
  "option-yellow": "[--text-mark:var(--option-yellow)]",
  "option-green": "[--text-mark:var(--option-green)]",
  "option-sky": "[--text-mark:var(--option-sky)]",
  "option-violet": "[--text-mark:var(--option-violet)]",
  "option-red": "[--text-mark:var(--option-red)]",
  "option-purple": "[--text-mark:var(--option-purple)]",
} as const satisfies Record<TextMarkTone, string>;

/** The fill's wash, in percent of the hue, for the highlight rule. */
const FILL_PERCENT = {
  rest: { light: 30, dark: 20 },
  active: { light: 45, dark: 35 },
} as const satisfies Record<
  TextMarkHighlightRuleOptions["state"],
  { light: number; dark: number }
>;

type TextMarkLayer = "fill" | "line";

const WASH_CLASS = {
  fill: {
    rest: "bg-(--text-mark)/30 dark:bg-(--text-mark)/20",
    matched: "bg-(--text-mark)/30 dark:bg-(--text-mark)/20",
    active:
      "bg-(--text-mark)/45 dark:bg-(--text-mark)/35 ring-1 ring-(--text-mark)",
  },
  line: {
    rest: "bg-transparent",
    matched: "bg-(--text-mark)/15",
    active:
      "bg-(--text-mark)/30 dark:bg-(--text-mark)/20 ring-1 ring-(--text-mark)",
  },
} as const satisfies Record<TextMarkLayer, Record<TextMarkState, string>>;

const WEIGHT_CLASS = {
  inherit: "",
  medium: "font-medium",
} as const satisfies Record<TextMarkWeight, string>;
