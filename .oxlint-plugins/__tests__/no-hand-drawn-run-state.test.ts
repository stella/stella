import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-hand-drawn-run-state";

const lint = async (source: string) =>
  await lintSingleRule(RULE, source, { sourcePath: "source.tsx" });

describe("no-hand-drawn-run-state", () => {
  test.each([
    [
      "a switch on a run state that renders a glyph",
      'const Mark = ({ state }) => { switch (state) { case "needs-you": return <span>!</span>; default: return null; } };',
    ],
    [
      "a switch on the contract's constants that renders a status mark",
      'const Mark = ({ state }) => { switch (state) { case CHAT_ACTIVE_RUN_STATE.working: return <StatusMark status="running" />; default: return null; } };',
    ],
    [
      "a conditional on a run state that renders",
      'const mark = state === CHAT_ACTIVE_RUN_STATE.working ? <StatusMark status="running" /> : null;',
    ],
    [
      "a run state guarding markup with &&",
      'const mark = state === "needs-you" && <Icon />;',
    ],
    [
      "an if on a run state that returns markup",
      'const Mark = ({ state }) => { if ("needs-you" === state) { return <b>!</b>; } return null; };',
    ],
    [
      "a colour utility chosen by run state",
      'const tone = state === "needs-you" ? "text-warning-foreground" : "";',
    ],
    [
      "a colour utility in a template chosen by run state",
      "const tone = state === CHAT_ACTIVE_RUN_STATE.needsYou ? `font-bold text-amber-600` : `text-xs`;",
    ],
    [
      "a lookup of marks keyed by run state",
      'const MARKS = { "needs-you": <span>!</span>, working: <Spinner /> };',
    ],
    [
      "a lookup of tones keyed by the contract's constants",
      'const TONES = { [CHAT_ACTIVE_RUN_STATE.needsYou]: "text-warning-foreground", [CHAT_ACTIVE_RUN_STATE.working]: "text-muted-foreground" };',
    ],
  ])("flags %s", async (_name, source) => {
    expect(await lint(source)).toEqual([1]);
  });

  test.each([
    [
      "the owner's mark",
      'const mark = <RunStateMark size="row" state={state} />;',
    ],
    [
      "words chosen by run state",
      'const label = state === CHAT_ACTIVE_RUN_STATE.needsYou ? t("needsYou") : t("working");',
    ],
    [
      "counts by run state",
      'switch (state) { case "needs-you": needsYou += 1; break; case "working": working += 1; break; }',
    ],
    [
      "an order keyed by run state",
      "const RANK = { [CHAT_ACTIVE_RUN_STATE.needsYou]: 0, [CHAT_ACTIVE_RUN_STATE.working]: 1 };",
    ],
    [
      "sizes that are not colours",
      'const size = state === "needs-you" ? "text-xs leading-none" : "size-3";',
    ],
    [
      "markup on a branch of another value",
      'const mark = status === "running" ? <StatusMark status="running" /> : null;',
    ],
  ])("accepts %s", async (_name, source) => {
    expect(await lint(source)).toEqual([]);
  });
});
