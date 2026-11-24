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
      kind: "free",
      command: { action: BROWSER_CONTROL_ACTION.open, url: `${SITE}/` },
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
    kind: "free" | "click" | "search" | "type";
    command: BrowserControlCommand;
  }[];

/** Jan's rule (2026-11-12), per level: which kinds ask, run or are refused. */
const RULE = {
  plan: { click: "refuse", search: "refuse", type: "refuse" },
  ask: { click: "ask", search: "run", type: "ask" },
  auto: { click: "run", search: "run", type: "ask" },
  full_auto: { click: "run", search: "run", type: "run" },
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
}: {
  granted: boolean;
  kind: "free" | "click" | "search" | "type";
  level: DesktopRunnerApprovalMode;
  ref: string;
  report: keyof typeof PAGE_REPORTS;
  signIn: boolean;
  stepName: string;
}): BrowserStepDecision => {
  if (kind === "free") {
    return { type: "run", by: "level" };
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
  test("every level, step, website approval, page report and sign-in", () => {
    let cases = 0;
    for (const level of LEVELS) {
      for (const ref of [TOP_FIELD, FRAME_FIELD]) {
        for (const step of STEPS(ref)) {
          for (const report of REPORT_NAMES) {
            for (const granted of [false, true]) {
              for (const signIn of [false, true]) {
                cases += 1;
                const decision = decideBrowserStep({
                  command: step.command,
                  grantedOrigins: new Set(granted ? [SITE] : []),
                  level,
                  reportedPage: PAGE_REPORTS[report],
                  signIn,
                });
                expect({
                  level,
                  ref,
                  report,
                  granted,
                  signIn,
                  step: step.name,
                  decision,
                }).toEqual({
                  level,
                  ref,
                  report,
                  granted,
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
                  }),
                });
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(LEVELS.length * 2 * 11 * 5 * 2 * 2);
  });

  test("a website approval never lifts Plan or a sign-in", () => {
    for (const step of STEPS(TOP_FIELD).filter(({ kind }) => kind !== "free")) {
      const granted = new Set([SITE]);
      expect(
        decideBrowserStep({
          command: step.command,
          grantedOrigins: granted,
          level: "plan",
          reportedPage: PAGE_REPORTS.same,
          signIn: false,
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
        }),
      ).toEqual({ type: "ask", site: SITE });
    }
  });
});
