// Passive regression fixture for `no-hand-drawn-run-state/no-hand-drawn-run-state`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { panic } from "better-result";

declare const CHAT_ACTIVE_RUN_STATE: {
  readonly needsYou: "needs-you";
  readonly working: "working";
};
declare const state: "needs-you" | "working";
declare const t: (key: string) => string;
declare const StatusMark: (props: { status: "running" }) => null;
declare const RunStateMark: (props: { state: "needs-you" | "working" }) => null;

// --- Flagged: a run state drawn outside its owner ---
export const _a = () => {
  // oxlint-disable-next-line no-hand-drawn-run-state/no-hand-drawn-run-state -- regression fixture for a hand-drawn glyph
  switch (state) {
    case "needs-you":
      return <span className="font-bold">!</span>;
    case "working":
      return null;
  }
  state satisfies never;
  return panic("unknown run state");
};
export const _b = () =>
  // oxlint-disable-next-line no-hand-drawn-run-state/no-hand-drawn-run-state -- regression fixture for a hand-drawn running mark
  state === CHAT_ACTIVE_RUN_STATE.working ? <StatusMark status="running" /> : null;
// oxlint-disable-next-line no-hand-drawn-run-state/no-hand-drawn-run-state -- regression fixture for a tone keyed by run state
export const _c = { [CHAT_ACTIVE_RUN_STATE.needsYou]: "text-warning-foreground" };

// --- Accepted: the owner's mark, and words chosen by state ---
// expect-clean: no-hand-drawn-run-state/no-hand-drawn-run-state
export const _d = () => <RunStateMark state={state} />;
// expect-clean: no-hand-drawn-run-state/no-hand-drawn-run-state
export const _e =
  state === CHAT_ACTIVE_RUN_STATE.needsYou ? t("needsYou") : t("working");
