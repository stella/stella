// The mark of an open run of work, shared by its two renderers: the web's
// (./run-state-mark.tsx) and React Native's (./run-state-mark.native.tsx).
// This table is the one place a run state gets its look; the
// `no-hand-drawn-run-state` lint rule keeps every other module from drawing
// one, so the web sidebar and the phone's chat list cannot drift apart.
//
// A run waiting on the reader is a bold "!" in the warning tone. A run in
// progress is `StatusMark`'s turning arc, monochrome as every status mark
// is: in the muted foreground, the colour of the line it sits on.

/** The theme colours a run mark takes, as the classes and variables naming them. */
export const RUN_MARK_TONES = {
  muted: {
    textClass: "text-muted-foreground",
    variable: "--color-muted-foreground",
  },
  warning: {
    textClass: "text-warning-foreground",
    variable: "--color-warning-foreground",
  },
} as const;

type RunMarkSpec = {
  readonly glyph: "attention" | "running";
  readonly tone: keyof typeof RUN_MARK_TONES;
};

/**
 * Each run state's glyph and tone. Its keys are the states the API reports
 * (`CHAT_ACTIVE_RUN_STATE` in `@stll/api-contract/chat`, which this published
 * package cannot import). A surface passes the state it read, so a state the
 * API adds stops compiling at every surface until it has a mark here.
 */
export const RUN_STATE_MARKS = {
  "needs-you": { glyph: "attention", tone: "warning" },
  working: { glyph: "running", tone: "muted" },
} as const satisfies Record<string, RunMarkSpec>;

export type RunMarkState = keyof typeof RUN_STATE_MARKS;

/**
 * `row` sits in a line of text, `badge` on a small icon. The pixel size is a
 * phone's; the web sets the same size with the classes.
 */
export const RUN_MARK_SIZES = {
  row: { glyphClass: "text-xs", markClass: "size-3", px: 12 },
  badge: { glyphClass: "text-3xs", markClass: "size-2.5", px: 10 },
} as const;

export type RunMarkSize = keyof typeof RUN_MARK_SIZES;

/**
 * The props every run mark renderer accepts. The mark is decorative: the
 * element around it names the state for assistive technology.
 */
export type RunStateMarkContract = {
  state: RunMarkState;
  size?: RunMarkSize;
};
