import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_TARGET_METADATA,
  type BrowserControlCommand,
} from "./browser-control";
import {
  type BrowserReportedPage,
  type BrowserStepDecision,
  decideBrowserStep,
} from "./browser-step-gate";
import {
  DESKTOP_RUNNER_APPROVAL_MODES,
  type DesktopRunnerApprovalMode,
} from "./desktop-runner";

const SITE = "https://example.com";
const PAGE = { revision: "revision-1", url: `${SITE}/search?q=1` } as const;
const TOP_FIELD = "e:0:0.4";
const FRAME_FIELD = "e:3:0.1";
const ABSENT = { type: BROWSER_CONTROL_TARGET_METADATA.absent } as const;

const target = (role: string, ref: string) => ({
  context: ABSENT,
  href: ABSENT,
  name: "Field",
  ref,
  role,
});

/**
 * Every step a chat can take, by how Jan's rule names it. `kind` is what the
 * rule says of it, written out here rather than read from the gate.
 */
const STEPS = (ref: string) =>
  [
    {
      name: "open",
      kind: "open",
      command: { action: BROWSER_CONTROL_ACTION.open, url: `${SITE}/` },
    },
    {
      name: "open in a new tab",
      kind: "open",
      command: {
        action: BROWSER_CONTROL_ACTION.open,
        newTab: true,
        url: `${SITE}/search?q=contract`,
      },
    },
    {
      name: "snapshot",
      kind: "free",
      command: { action: BROWSER_CONTROL_ACTION.snapshot },
    },
    {
      name: "find",
      kind: "free",
      command: {
        action: BROWSER_CONTROL_ACTION.find,
        search: { query: "x", type: "text" },
      },
    },
    {
      name: "go back",
      kind: "free",
      command: { action: BROWSER_CONTROL_ACTION.goBack },
    },
    {
      name: "switch tab",
      kind: "free",
      command: {
        action: BROWSER_CONTROL_ACTION.switchTab,
        tabId: 7,
        url: `${SITE}/`,
      },
    },
    {
      name: "click",
      kind: "click",
      command: {
        action: BROWSER_CONTROL_ACTION.click,
        page: PAGE,
        target: target("button", ref),
      },
    },
    {
      name: "Enter in another field",
      kind: "click",
      command: {
        action: BROWSER_CONTROL_ACTION.pressKey,
        key: "Enter",
        page: PAGE,
        target: target("textbox", ref),
      },
    },
    {
      name: "Enter in a search field",
      kind: "click",
      command: {
        action: BROWSER_CONTROL_ACTION.pressKey,
        key: "Enter",
        page: PAGE,
        target: target("searchbox", ref),
      },
    },
    {
      name: "typing into a search field",
      kind: "search",
      command: {
        action: BROWSER_CONTROL_ACTION.fill,
        page: PAGE,
        target: target("searchbox", ref),
        value: "contract",
      },
    },
    {
      name: "typing into another field",
      kind: "type",
      command: {
        action: BROWSER_CONTROL_ACTION.fill,
        page: PAGE,
        target: target("textbox", ref),
        value: "Jane",
      },
    },
    {
      name: "choosing an option",
      kind: "type",
      command: {
        action: BROWSER_CONTROL_ACTION.select,
        page: PAGE,
        target: target("combobox", ref),
        value: "2024",
      },
    },
  ] as const satisfies readonly {
    name: string;
    kind: "free" | "open" | "click" | "search" | "type";
    command: BrowserControlCommand;
  }[];

/**
 * Jan's rule (2026-11-12, opening 2026-11-25), per level: which kinds ask,
 * run or are refused. `open` is opening a website the chat has not been on.
 */
const RULE = {
  plan: { open: "run", click: "refuse", search: "refuse", type: "refuse" },
  ask: { open: "ask", click: "ask", search: "run", type: "ask" },
  auto: { open: "run", click: "run", search: "run", type: "ask" },
  full_auto: { open: "run", click: "run", search: "run", type: "run" },
} as const;

const PAGE_REPORTS = {
  /** The browser reported the page the step was written for. */
  same: { ...PAGE, valueRefs: new Set([TOP_FIELD, FRAME_FIELD]) },
  /** The same page, but the browser never reported a value for the field. */
  noValue: { ...PAGE, valueRefs: new Set<string>() },
  /** The tab moved on: a newer revision of the same address. */
  newer: { ...PAGE, revision: "revision-2", valueRefs: new Set([TOP_FIELD]) },
  /** The tab is on another website now. */
  elsewhere: {
    revision: "revision-1",
    url: "https://other.example/",
    valueRefs: new Set([TOP_FIELD]),
  },
  /** Nothing reported, or the latest step did not settle. */
  none: null,
} as const satisfies Record<string, BrowserReportedPage | null>;

const REPORT_NAMES = [
  "same",
  "noValue",
  "newer",
  "elsewhere",
  "none",
] as const satisfies readonly (keyof typeof PAGE_REPORTS)[];

const LEVELS: readonly DesktopRunnerApprovalMode[] =
  DESKTOP_RUNNER_APPROVAL_MODES;

const expected = ({
  granted,
  kind,
  level,
  ref,
  report,
  signIn,
  stepName,
  visited,
}: {
  granted: boolean;
  kind: "free" | "open" | "click" | "search" | "type";
  level: DesktopRunnerApprovalMode;
  ref: string;
  report: keyof typeof PAGE_REPORTS;
  signIn: boolean;
  stepName: string;
  visited: boolean;
}): BrowserStepDecision => {
  if (kind === "free") {
    return { type: "run", by: "level" };
  }
  // Opening names its own website, whatever the tab shows or asks for.
  if (kind === "open") {
    if (visited) {
      return { type: "run", by: "visited", origin: SITE };
    }
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
  const byLevel = RULE[level][kind];
  if (byLevel !== "ask") {
    return byLevel === "run"
      ? { type: "run", by: "level" }
      : { type: "refuse" };
  }
  const typing = stepName.startsWith("typing");
  const proven = report === "same" || (report === "noValue" && !typing);
  return granted && proven && ref === TOP_FIELD
    ? { type: "run", by: "site-grant", origin: SITE }
    : { type: "ask", site: SITE };
};

describe("decideBrowserStep", () => {
  test("every level, step, website approval, visit, page report and sign-in", () => {
    let cases = 0;
    for (const level of LEVELS) {
      for (const ref of [TOP_FIELD, FRAME_FIELD]) {
        for (const step of STEPS(ref)) {
          for (const report of REPORT_NAMES) {
            for (const granted of [false, true]) {
              for (const visited of [false, true]) {
                for (const signIn of [false, true]) {
                  cases += 1;
                  const decision = decideBrowserStep({
                    command: step.command,
                    grantedOrigins: new Set(granted ? [SITE] : []),
                    level,
                    reportedPage: PAGE_REPORTS[report],
                    signIn,
                    visitedOrigins: new Set(visited ? [SITE] : []),
                  });
                  expect({
                    level,
                    ref,
                    report,
                    granted,
                    visited,
                    signIn,
                    step: step.name,
                    decision,
                  }).toEqual({
                    level,
                    ref,
                    report,
                    granted,
                    visited,
                    signIn,
                    step: step.name,
                    decision: expected({
                      granted,
                      kind: step.kind,
                      level,
                      ref,
                      report,
                      signIn,
                      stepName: step.name,
                      visited,
                    }),
                  });
                }
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(LEVELS.length * 2 * 12 * 5 * 2 * 2 * 2);
  });

  test("on Ask, opening a website the chat has not been on asks, by its origin", () => {
    const open = (url: string) =>
      decideBrowserStep({
        command: { action: BROWSER_CONTROL_ACTION.open, url },
        grantedOrigins: new Set(["https://granted.example"]),
        level: "ask",
        reportedPage: PAGE_REPORTS.same,
        signIn: false,
        visitedOrigins: new Set([SITE]),
      });
    // The page the tab shows is no visit to another website.
    expect(open("https://other.example/?q=1")).toEqual({
      type: "ask",
      site: "https://other.example",
    });
    // A visit is by exact origin: not a subdomain, not plain http.
    expect(open("https://www.example.com/")).toEqual({
      type: "ask",
      site: "https://www.example.com",
    });
    expect(open("http://example.com/")).toEqual({ type: "ask", site: null });
    // An address no approval can name always asks, and offers none.
    expect(open("https://user:secret@example.com/")).toEqual({
      type: "ask",
      site: null,
    });
    expect(open(`${SITE}/any/path?q=2`)).toEqual({
      type: "run",
      by: "visited",
      origin: SITE,
    });
    expect(open("https://granted.example/a")).toEqual({
      type: "run",
      by: "site-grant",
      origin: "https://granted.example",
    });
  });

  test("a website approval never lifts Plan or a sign-in", () => {
    for (const step of STEPS(TOP_FIELD).filter(
      ({ kind }) => kind !== "free" && kind !== "open",
    )) {
      const granted = new Set([SITE]);
      expect(
        decideBrowserStep({
          command: step.command,
          grantedOrigins: granted,
          level: "plan",
          reportedPage: PAGE_REPORTS.same,
          signIn: false,
          visitedOrigins: new Set(),
        }),
      ).toEqual({ type: "refuse" });
      for (const level of LEVELS) {
        expect(
          decideBrowserStep({
            command: step.command,
            grantedOrigins: granted,
            level,
            reportedPage: PAGE_REPORTS.same,
            signIn: true,
            visitedOrigins: new Set(),
          }),
        ).toEqual({ type: "needs_member" });
      }
    }
  });

  test("an approval for one origin covers neither its subdomain nor plain http", () => {
    const click = {
      action: BROWSER_CONTROL_ACTION.click,
      page: PAGE,
      target: target("button", TOP_FIELD),
    } satisfies BrowserControlCommand;
    for (const origin of ["https://www.example.com", "http://example.com"]) {
      expect(
        decideBrowserStep({
          command: click,
          grantedOrigins: new Set([origin]),
          level: "ask",
          reportedPage: PAGE_REPORTS.same,
          signIn: false,
          visitedOrigins: new Set(),
        }),
      ).toEqual({ type: "ask", site: SITE });
    }
  });
});
