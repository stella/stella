import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_TARGET_METADATA,
  type BrowserControlCommand,
} from "./browser-control";
import { browserSiteGrantOrigin } from "./browser-site-grants";
import {
  BROWSER_STEP_GATE,
  type BrowserReportedPage,
  type BrowserStepAskReason,
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
      : { type: "ask", site: SITE, reason: "site_not_allowed" };
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
  const ask = (reason: BrowserStepAskReason): BrowserStepDecision => ({
    type: "ask",
    site: SITE,
    reason,
  });
  if (!granted) {
    return ask("site_not_allowed");
  }
  if (report !== "same" && report !== "noValue") {
    return ask("page_unconfirmed");
  }
  if (ref !== TOP_FIELD) {
    return ask("embedded_frame");
  }
  if (typing && report === "noValue") {
    return ask("possible_secret");
  }
  return { type: "run", by: "site-grant", origin: SITE };
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
      reason: "site_not_allowed",
    });
    // A visit is by exact origin: not a subdomain, not plain http.
    expect(open("https://www.example.com/")).toEqual({
      type: "ask",
      site: "https://www.example.com",
      reason: "site_not_allowed",
    });
    expect(open("http://example.com/")).toEqual({
      type: "ask",
      site: null,
      reason: "no_site",
    });
    // An address no approval can name always asks, and offers none.
    expect(open("https://user:secret@example.com/")).toEqual({
      type: "ask",
      site: null,
      reason: "no_site",
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
      ).toEqual({ type: "ask", site: SITE, reason: "site_not_allowed" });
    }
  });
});

describe("why a step on an element asks", () => {
  const ORIGINS = [
    SITE,
    "https://www.example.com",
    "http://example.com",
    "https://other.example",
  ] as const;
  const REVISIONS = ["revision-1", "revision-2", "revision-3"] as const;
  const page = fc.record({
    revision: fc.constantFrom(...REVISIONS),
    url: fc
      .tuple(fc.constantFrom(...ORIGINS), fc.constantFrom("/", "/search?q=1"))
      .map(([origin, path]) => `${origin}${path}`),
  });
  const ref = fc.constantFrom(TOP_FIELD, FRAME_FIELD, "e:0:0.7");
  const step = fc
    .record({
      action: fc.constantFrom(
        BROWSER_CONTROL_ACTION.click,
        BROWSER_CONTROL_ACTION.fill,
        BROWSER_CONTROL_ACTION.pressKey,
        BROWSER_CONTROL_ACTION.select,
      ),
      page,
      ref,
    })
    .map(({ action, page: written, ref: element }): BrowserControlCommand => {
      const on = { page: written, target: target("textbox", element) };
      switch (action) {
        case BROWSER_CONTROL_ACTION.click:
          return { action, ...on };
        case BROWSER_CONTROL_ACTION.fill:
          return { action, ...on, value: "x" };
        case BROWSER_CONTROL_ACTION.pressKey:
          return { action, ...on, key: "Enter" };
        case BROWSER_CONTROL_ACTION.select:
          return { action, ...on, value: "2024" };
        default:
          action satisfies never;
          throw new TypeError("Unhandled action");
      }
    });
  const reported = fc.option(
    fc.record({
      revision: fc.constantFrom(...REVISIONS),
      url: page.map(({ url }) => url),
      valueRefs: fc
        .subarray([TOP_FIELD, FRAME_FIELD, "e:0:0.7"])
        .map((refs) => new Set(refs)),
    }),
    { nil: null },
  );
  const granted = fc
    .subarray([...ORIGINS])
    .map((origins) => new Set<string>(origins));
  const decide = (
    command: BrowserControlCommand,
    reportedPage: BrowserReportedPage | null,
    grantedOrigins: ReadonlySet<string>,
  ) =>
    decideBrowserStep({
      command,
      grantedOrigins,
      level: "ask",
      reportedPage,
      signIn: false,
      visitedOrigins: new Set(),
    });

  test("a website approval answers a step only on the very page, frame and field the browser reported", () => {
    assertProperty(
      "a website approval answers a step only on the very page, frame and field the browser reported",
      fc.property(step, reported, granted, (command, report, grants) => {
        if (!("target" in command)) {
          return;
        }
        const decision = decide(command, report, grants);
        const site = browserSiteGrantOrigin(command.page.url);
        const covered =
          site !== null &&
          grants.has(site) &&
          report !== null &&
          report.url === command.page.url &&
          report.revision === command.page.revision &&
          command.target.ref.startsWith("e:0:") &&
          (command.action !== BROWSER_CONTROL_ACTION.fill ||
            report.valueRefs.has(command.target.ref));
        expect(decision.type).toBe(
          covered ? BROWSER_STEP_GATE.run : BROWSER_STEP_GATE.ask,
        );
        if (decision.type === BROWSER_STEP_GATE.ask) {
          expect(decision.site).toBe(site);
        }
      }),
    );
  });

  test("always allowing the website changes the answer exactly when the question said the website is not allowed", () => {
    assertProperty(
      "always allowing the website changes the answer exactly when the question said the website is not allowed",
      fc.property(step, reported, granted, (command, report, grants) => {
        const decision = decide(command, report, grants);
        if (decision.type !== BROWSER_STEP_GATE.ask || decision.site === null) {
          return;
        }
        const after = decide(
          command,
          report,
          new Set([...grants, decision.site]),
        );
        if (decision.reason === "site_not_allowed") {
          expect(grants.has(decision.site)).toBe(false);
          expect(after).not.toEqual(decision);
        } else {
          expect(grants.has(decision.site)).toBe(true);
          expect(after).toEqual(decision);
        }
      }),
    );
  });
});
