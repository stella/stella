import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TARGET_METADATA,
  type BrowserControlCommand,
  type BrowserControlResult,
} from "@stll/api-contract/browser-control";
import type { BrowserStepDecision } from "@stll/api-contract/browser-step-gate";
import {
  DESKTOP_RUNNER_APPROVAL_MODES,
  type DesktopRunnerApprovalMode,
} from "@stll/api-contract/desktop-runner";

import { createBrowserApprovalState } from "./browser-approval-state";

const SITE = "https://example.com";
const PAGE_URL = `${SITE}/search`;
const ABSENT = { type: BROWSER_CONTROL_TARGET_METADATA.absent } as const;
const FIELD = "e:0:0.4";

const pageRead = (
  url: string,
  revision: string,
  fieldValue: string | undefined,
): BrowserControlResult => ({
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  snapshot: {
    contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
    elements: [
      {
        context: ABSENT,
        href: ABSENT,
        id: "E1",
        name: "Field",
        ref: FIELD,
        role: "textbox",
        ...(fieldValue === undefined ? {} : { value: fieldValue }),
      },
    ],
    elementsLeftOut: false,
    facts: { meta: [] },
    revision,
    tabId: 7,
    tabs: [{ active: true, tabId: 7, url }],
    text: "Ready",
    title: "Example",
    url,
    window: { cursor: "r1.window", fromPercent: 0, toPercent: 100 },
  },
  status: "success",
});

const SIGN_IN = {
  code: BROWSER_CONTROL_ERROR_CODE.needsMember,
  message: "The page asks for a sign-in.",
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
} as const satisfies BrowserControlResult;

const at = (role: string) => ({
  page: { revision: "revision-1", url: PAGE_URL },
  target: { context: ABSENT, href: ABSENT, name: "Field", ref: FIELD, role },
});

/** Each step and the kind Jan's rule (2026-11-12, opening 2026-11-25) names it by. */
const STEPS = [
  { kind: "open", command: { action: "open", url: `${SITE}/` } },
  { kind: "free", command: { action: "snapshot" } },
  {
    kind: "free",
    command: { action: "find", search: { query: "x", type: "text" } },
  },
  { kind: "free", command: { action: "go-back" } },
  {
    kind: "free",
    command: { action: "switch-tab", tabId: 7, url: `${SITE}/` },
  },
  { kind: "click", command: { action: "click", ...at("button") } },
  {
    kind: "click",
    command: { action: "press-key", key: "Enter", ...at("textbox") },
  },
  {
    kind: "click",
    command: { action: "press-key", key: "Enter", ...at("searchbox") },
  },
  {
    kind: "search",
    command: { action: "fill", value: "notice", ...at("searchbox") },
  },
  { kind: "type", command: { action: "fill", value: "x", ...at("textbox") } },
  {
    kind: "type",
    command: { action: "select", value: "2024", ...at("combobox") },
  },
] as const satisfies readonly {
  kind: "free" | "open" | "click" | "search" | "type";
  command: BrowserControlCommand;
}[];

/** `open` is opening a website the chat has not been on. */
const RULE = {
  plan: { open: "run", click: "refuse", search: "refuse", type: "refuse" },
  ask: { open: "ask", click: "ask", search: "run", type: "ask" },
  auto: { open: "run", click: "run", search: "run", type: "ask" },
  full_auto: { open: "run", click: "run", search: "run", type: "run" },
} as const satisfies Record<
  DesktopRunnerApprovalMode,
  Record<"open" | "click" | "search" | "type", "run" | "ask" | "refuse">
>;

const THREAD = "thread-1";

/**
 * What the extension told this tab before the step: the page the step was
 * written for, the same page with no value for the field, a newer read, a
 * read of another site, a read whose last command failed, or nothing.
 */
const HISTORIES = {
  same: (state: ReturnType<typeof createBrowserApprovalState>) => {
    state.observeResult(pageRead(PAGE_URL, "revision-1", "draft"));
    state.beginCommand()(true);
  },
  noValue: (state: ReturnType<typeof createBrowserApprovalState>) => {
    state.observeResult(pageRead(PAGE_URL, "revision-1", undefined));
    state.beginCommand()(true);
  },
  newer: (state: ReturnType<typeof createBrowserApprovalState>) => {
    state.observeResult(pageRead(PAGE_URL, "revision-2", "draft"));
    state.beginCommand()(true);
  },
  elsewhere: (state: ReturnType<typeof createBrowserApprovalState>) => {
    state.observeResult(pageRead("https://other.test/", "revision-1", "x"));
    state.beginCommand()(true);
  },
  failed: (state: ReturnType<typeof createBrowserApprovalState>) => {
    state.observeResult(pageRead(PAGE_URL, "revision-1", "draft"));
    state.beginCommand()(true);
    state.beginCommand()(false);
  },
  none: (_state: ReturnType<typeof createBrowserApprovalState>) => undefined,
} as const satisfies Record<
  string,
  (state: ReturnType<typeof createBrowserApprovalState>) => void
>;

describe("the browser gate on what the extension reported", () => {
  test("every level, step, website approval, report and sign-in", () => {
    for (const level of DESKTOP_RUNNER_APPROVAL_MODES) {
      for (const step of STEPS) {
        for (const [history, tell] of Object.entries(HISTORIES)) {
          for (const granted of [false, true]) {
            for (const signIn of [false, true]) {
              const state = createBrowserApprovalState();
              tell(state);
              if (signIn) {
                state.observeResult(SIGN_IN);
              }
              const decision = state.decide({
                command: step.command,
                grantedOrigins: new Set(granted ? [SITE] : []),
                level,
                threadId: THREAD,
              });
              const expected = ((): BrowserStepDecision => {
                if (step.kind === "free") {
                  return { type: "run", by: "level" };
                }
                // Nothing here was a visit of this chat's: only its own
                // commands' pages are (`observeVisit`).
                if (step.kind === "open") {
                  if (RULE[level].open === "run") {
                    return { type: "run", by: "level" };
                  }
                  return granted
                    ? { type: "run", by: "site-grant", origin: SITE }
                    : { type: "ask", site: SITE };
                }
                if (signIn) {
                  return { type: "needs_member" };
                }
                const byLevel = RULE[level][step.kind];
                if (byLevel === "refuse") {
                  return { type: "refuse" };
                }
                if (byLevel === "run") {
                  return { type: "run", by: "level" };
                }
                const typing = step.command.action === "fill";
                const proven =
                  history === "same" || (history === "noValue" && !typing);
                return granted && proven
                  ? { type: "run", by: "site-grant", origin: SITE }
                  : { type: "ask", site: SITE };
              })();
              expect({
                level,
                step: step.command.action,
                kind: step.kind,
                history,
                granted,
                signIn,
                decision,
              }).toEqual({
                level,
                step: step.command.action,
                kind: step.kind,
                history,
                granted,
                signIn,
                decision: expected,
              });
            }
          }
        }
      }
    }
  });
});

describe("what the extension reported", () => {
  const click = STEPS[5].command;
  const GRANTED = new Set([SITE]);
  const byGrant = (state: ReturnType<typeof createBrowserApprovalState>) =>
    state.decide({
      command: click,
      grantedOrigins: GRANTED,
      level: "ask",
      threadId: THREAD,
    }).type === "run";

  test("a read of the page after a sign-in hand-over lets steps go on", () => {
    const state = createBrowserApprovalState();
    HISTORIES.same(state);
    state.observeResult(SIGN_IN);
    expect(
      state.decide({
        command: click,
        grantedOrigins: GRANTED,
        level: "ask",
        threadId: THREAD,
      }),
    ).toEqual({ type: "needs_member" });
    state.observeResult(pageRead(PAGE_URL, "revision-1", "draft"));
    state.beginCommand()(true);
    expect(byGrant(state)).toBe(true);
  });

  test("an error other than a sign-in keeps what it was", () => {
    const state = createBrowserApprovalState();
    state.observeResult(SIGN_IN);
    state.observeResult({
      ...SIGN_IN,
      code: BROWSER_CONTROL_ERROR_CODE.timedOut,
    });
    expect(
      state.decide({
        command: click,
        grantedOrigins: GRANTED,
        level: "auto",
        threadId: THREAD,
      }),
    ).toEqual({ type: "needs_member" });
  });

  test("a new pairing or handed-over tab forgets the page and the sign-in", () => {
    const state = createBrowserApprovalState();
    HISTORIES.same(state);
    expect(byGrant(state)).toBe(true);
    state.reset();
    expect(byGrant(state)).toBe(false);
    state.observeResult(SIGN_IN);
    state.reset();
    expect(
      state.decide({
        command: click,
        grantedOrigins: GRANTED,
        level: "auto",
        threadId: THREAD,
      }),
    ).toEqual({ type: "run", by: "level" });
  });

  test("a command that began before a reset cannot vouch for the new tab", () => {
    const state = createBrowserApprovalState();
    const finish = state.beginCommand();
    state.reset();
    state.observeResult(pageRead(PAGE_URL, "revision-1", "draft"));
    finish(true);
    expect(byGrant(state)).toBe(false);
  });

  test("an older command finishing late cannot vouch for a newer failure", () => {
    const state = createBrowserApprovalState();
    state.observeResult(pageRead(PAGE_URL, "revision-1", "draft"));
    const older = state.beginCommand();
    state.beginCommand()(false);
    older(true);
    expect(byGrant(state)).toBe(false);
    state.beginCommand()(true);
    expect(byGrant(state)).toBe(true);
  });

  test("commands started before an account change cannot vouch for it", () => {
    const state = createBrowserApprovalState();
    const finish = state.beginCommand();
    state.restoreOwner();
    finish(true);
    state.observeResult(pageRead(PAGE_URL, "revision-1", "draft"));
    expect(byGrant(state)).toBe(false);
  });

  test("an answer to a request sent under an earlier pairing changes nothing", () => {
    const state = createBrowserApprovalState();
    const sentUnder = state.pairing();
    state.reset();
    state.observeResult(pageRead(PAGE_URL, "revision-1", "draft"), sentUnder);
    state.observeResult(SIGN_IN, sentUnder);
    state.beginCommand()(true);
    expect(byGrant(state)).toBe(false);
    state.observeResult(
      pageRead(PAGE_URL, "revision-1", "draft"),
      state.pairing(),
    );
    state.beginCommand()(true);
    expect(byGrant(state)).toBe(true);
  });

  test("a find on another address after a failure cannot vouch for the earlier page", () => {
    const found = (url: string): BrowserControlResult => ({
      found: {
        contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
        matches: [],
        tabId: 7,
        title: "Example",
        total: 0,
        totalCapped: false,
        type: "text",
        url,
      },
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      status: "found",
    });
    const state = createBrowserApprovalState();
    HISTORIES.failed(state);
    state.observeResult(found("https://other.test/"));
    state.beginCommand()(true);
    expect(byGrant(state)).toBe(false);

    const same = createBrowserApprovalState();
    HISTORIES.failed(same);
    same.observeResult(found(PAGE_URL));
    same.beginCommand()(true);
    expect(byGrant(same)).toBe(true);
  });

  test("subscribers hear every change", () => {
    const state = createBrowserApprovalState();
    let heard = 0;
    const unsubscribe = state.subscribe(() => {
      heard += 1;
    });
    state.beginCommand()(true);
    state.observeResult(SIGN_IN);
    state.reset();
    unsubscribe();
    state.reset();
    expect(heard).toBe(4);
  });
});

describe("the websites a chat has been on", () => {
  const openAt = (url: string) =>
    ({ action: "open", url }) as const satisfies BrowserControlCommand;
  const decideOpen = (
    state: ReturnType<typeof createBrowserApprovalState>,
    url: string,
    threadId: string | null,
    level: DesktopRunnerApprovalMode = "ask",
  ) =>
    state.decide({
      command: openAt(url),
      grantedOrigins: new Set(),
      level,
      threadId,
    });

  test("on Ask a chat opens a website it has been on, and asks for any other", () => {
    const state = createBrowserApprovalState();
    expect(decideOpen(state, `${SITE}/a`, THREAD)).toEqual({
      type: "ask",
      site: SITE,
    });
    state.observeVisit(THREAD, pageRead(PAGE_URL, "revision-1", "draft"));
    expect(decideOpen(state, `${SITE}/other?q=1`, THREAD)).toEqual({
      type: "run",
      by: "visited",
      origin: SITE,
    });
    expect(decideOpen(state, "https://other.test/", THREAD)).toEqual({
      type: "ask",
      site: "https://other.test",
    });
    // Another chat of the web tab, or no known chat, has been on none.
    expect(decideOpen(state, `${SITE}/a`, "thread-2")).toEqual({
      type: "ask",
      site: SITE,
    });
    expect(decideOpen(state, `${SITE}/a`, null)).toEqual({
      type: "ask",
      site: SITE,
    });
  });

  test("only a page the browser reported is a visit, and a new pairing keeps them", () => {
    const state = createBrowserApprovalState();
    state.observeVisit(THREAD, SIGN_IN);
    expect(decideOpen(state, `${SITE}/a`, THREAD).type).toBe("ask");
    state.observeVisit(THREAD, pageRead(PAGE_URL, "revision-1", "draft"));
    state.reset();
    expect(decideOpen(state, `${SITE}/a`, THREAD).type).toBe("run");
  });

  test("Auto, Full auto and Plan open any website without asking", () => {
    const state = createBrowserApprovalState();
    for (const level of DESKTOP_RUNNER_APPROVAL_MODES.filter(
      (mode) => mode !== "ask",
    )) {
      expect(decideOpen(state, "https://other.test/", THREAD, level)).toEqual({
        type: "run",
        by: "level",
      });
    }
  });

  test("an account change forgets every chat's websites and turn levels", () => {
    const state = createBrowserApprovalState();
    state.observeVisit(THREAD, pageRead(PAGE_URL, "revision-1", "draft"));
    state.recordTurnLevel(THREAD, "turn-1", "full_auto");
    state.restoreOwner();
    expect(decideOpen(state, `${SITE}/a`, THREAD).type).toBe("ask");
    expect(state.turnLevel(THREAD, "turn-1")).toBeNull();
  });
});

describe("the level each turn was sent with", () => {
  test("is kept per chat and turn, and a new send of the turn replaces it", () => {
    const state = createBrowserApprovalState();
    state.recordTurnLevel(THREAD, "turn-1", "ask");
    state.recordTurnLevel("thread-2", "turn-1", "full_auto");
    expect(state.turnLevel(THREAD, "turn-1")).toBe("ask");
    expect(state.turnLevel("thread-2", "turn-1")).toBe("full_auto");
    expect(state.turnLevel(THREAD, "turn-2")).toBeNull();
    state.recordTurnLevel(THREAD, "turn-1", "plan");
    expect(state.turnLevel(THREAD, "turn-1")).toBe("plan");
  });

  test("keeps the newest turns only", () => {
    const state = createBrowserApprovalState();
    for (let turn = 0; turn <= 256; turn += 1) {
      state.recordTurnLevel(THREAD, `turn-${String(turn)}`, "auto");
    }
    expect(state.turnLevel(THREAD, "turn-0")).toBeNull();
    expect(state.turnLevel(THREAD, "turn-256")).toBe("auto");
  });
});
