import { panic } from "better-result";

import {
  BROWSER_CONTROL_ACTION,
  type BrowserControlCommand,
  type BrowserControlElementCommand,
  parseElementReference,
} from "./browser-control";
import { browserSiteGrantOrigin } from "./browser-site-grants";
import type { DesktopRunnerApprovalMode } from "./desktop-runner";

/**
 * Whether a browser step runs, waits for the member, or does not run. One
 * gate for every chat that controls a browser: a chat on stella's models
 * (the web app answers its `use-browser` cards) and a chat on the member's
 * computer (the desktop's browser tools) decide every step here, so the
 * same permission level and the same website approvals do the same thing
 * on both.
 */
export const BROWSER_STEP_GATE = {
  /** The step runs without asking. */
  run: "run",
  /** The member is asked first. */
  ask: "ask",
  /** Plan is read-only: the step does not run, and nobody is asked. */
  refuse: "refuse",
  /**
   * The page asks for a sign-in: the member signs in themselves, in the
   * browser, at every level. The step does not run.
   */
  needsMember: "needs_member",
} as const;

/** What a permission level answers for a kind of step. */
type BrowserLevelGate = Exclude<
  (typeof BROWSER_STEP_GATE)[keyof typeof BROWSER_STEP_GATE],
  typeof BROWSER_STEP_GATE.needsMember
>;

/**
 * The kinds of step on an element the levels tell apart. `search` is typing
 * into a search field; `click` is a click, or a key press in any element (it
 * can submit a form); `type` is typing anywhere else, or choosing an option.
 * A key press follows the click rule whatever role the page gives the
 * element: the role is the page's own word, and a page could call any form
 * field a search field to have it submitted without asking.
 */
export const BROWSER_STEP_KINDS = ["click", "search", "type"] as const;
export type BrowserStepKind = (typeof BROWSER_STEP_KINDS)[number];

/** The role the extension gives a search field, or a field in a search form. */
export const BROWSER_SEARCH_FIELD_ROLE = "searchbox";

/**
 * Each level's answer per kind of step. Opening, reading, finding, going
 * back and switching between the chat's tabs never ask at any level, so
 * they have no row here. Plan opens and reads only. A level added to the
 * contract fails here until its rule is set.
 */
export const BROWSER_LEVEL_GATES = {
  plan: { click: "refuse", search: "refuse", type: "refuse" },
  ask: { click: "ask", search: "run", type: "ask" },
  auto: { click: "run", search: "run", type: "ask" },
  full_auto: { click: "run", search: "run", type: "run" },
} as const satisfies Record<
  DesktopRunnerApprovalMode,
  Record<BrowserStepKind, BrowserLevelGate>
>;

/** The kind of a step on an element. */
export const browserStepKind = (
  command: BrowserControlElementCommand,
): BrowserStepKind => {
  const inSearchField = command.target.role === BROWSER_SEARCH_FIELD_ROLE;
  switch (command.action) {
    case BROWSER_CONTROL_ACTION.click:
      return "click";
    case BROWSER_CONTROL_ACTION.pressKey:
      return "click";
    case BROWSER_CONTROL_ACTION.fill:
      return inSearchField ? "search" : "type";
    case BROWSER_CONTROL_ACTION.select:
      return "type";
    default:
      command satisfies never;
      return panic("Unhandled browser element command");
  }
};

/**
 * The page the browser itself last reported for the tab a step acts on:
 * its address and revision from the latest successful result, never an
 * address the model wrote or text read from the page.
 */
export type BrowserReportedPage = {
  revision: string;
  url: string;
  /**
   * Element refs the browser reported a value for. The browser withholds
   * the value of every field it treats as secret, so typing into a field
   * outside this set may be typing a secret.
   */
  valueRefs: ReadonlySet<string>;
};

export type BrowserStepGateInput = {
  level: DesktopRunnerApprovalMode;
  command: BrowserControlCommand;
  /**
   * What the browser last reported for the tab; null when nothing was
   * reported yet, or when the latest step did not settle on a page (it
   * failed, its outcome is unknown, or it still runs).
   */
  reportedPage: BrowserReportedPage | null;
  /**
   * The browser's latest answer for the tab handed a sign-in to the member
   * (`needs-member`), and no page was read there since.
   */
  signIn: boolean;
  /** The exact origins the member always allows (`browser-site-grants`). */
  grantedOrigins: ReadonlySet<string>;
};

export type BrowserStepDecision =
  | { type: typeof BROWSER_STEP_GATE.run; by: "level" }
  /** A website approval for `origin` answered the step. */
  | { type: typeof BROWSER_STEP_GATE.run; by: "site-grant"; origin: string }
  /**
   * `site` is the website the question names, by exact origin: the page
   * the step was written for. It is the website an "always allow on this
   * website" offer is for; null when it cannot hold an approval.
   */
  | { type: typeof BROWSER_STEP_GATE.ask; site: string | null }
  | { type: typeof BROWSER_STEP_GATE.refuse }
  | { type: typeof BROWSER_STEP_GATE.needsMember };

const RUNS_BY_LEVEL: BrowserStepDecision = {
  type: BROWSER_STEP_GATE.run,
  by: "level",
};

/** The top frame's id in an element reference (`e:<frameId>:<path>`). */
const TOP_FRAME_ID = 0;

/**
 * The website a website approval may answer `command` for: the origin of
 * the page the browser reported, and only when the command names that very
 * page (address and revision). The target must sit in the top frame: a read
 * merges every controllable frame, including another website's embedded
 * one, and names only the top frame's address. Typing into a field the
 * browser reported no value for may be typing a secret, so no approval
 * covers it.
 */
const grantableOrigin = (
  command: BrowserControlElementCommand,
  page: BrowserReportedPage | null,
): string | null => {
  if (
    page === null ||
    command.page.url !== page.url ||
    command.page.revision !== page.revision ||
    parseElementReference(command.target.ref)?.frameId !== TOP_FRAME_ID ||
    (command.action === BROWSER_CONTROL_ACTION.fill &&
      !page.valueRefs.has(command.target.ref))
  ) {
    return null;
  }
  return browserSiteGrantOrigin(page.url);
};

const elementStepDecision = (
  command: BrowserControlElementCommand,
  { grantedOrigins, level, reportedPage, signIn }: BrowserStepGateInput,
): BrowserStepDecision => {
  // A sign-in is the member's at every level, whatever the member allowed.
  if (signIn) {
    return { type: BROWSER_STEP_GATE.needsMember };
  }
  const gate = BROWSER_LEVEL_GATES[level][browserStepKind(command)];
  switch (gate) {
    case BROWSER_STEP_GATE.run:
      return RUNS_BY_LEVEL;
    case BROWSER_STEP_GATE.refuse:
      return { type: BROWSER_STEP_GATE.refuse };
    case BROWSER_STEP_GATE.ask: {
      const origin = grantableOrigin(command, reportedPage);
      return origin !== null && grantedOrigins.has(origin)
        ? { type: BROWSER_STEP_GATE.run, by: "site-grant", origin }
        : {
            type: BROWSER_STEP_GATE.ask,
            site: browserSiteGrantOrigin(command.page.url),
          };
    }
    default:
      gate satisfies never;
      return panic("Unhandled browser level gate");
  }
};

/**
 * Whether a browser step runs, asks, is refused or goes to the member.
 *
 * - Opening, reading, finding, going back and switching to another of the
 *   chat's tabs run at every level: they move between or read pages, which
 *   the browser holds to what the chat may reach.
 * - A step on an element of a page the browser handed to the member for a
 *   sign-in goes to the member at every level.
 * - Otherwise the level decides by the kind of step (`BROWSER_LEVEL_GATES`).
 *   A step the level would ask about runs without asking when the member
 *   always allows the website the browser reported the step acts on
 *   (`grantableOrigin`). A website approval never lifts Plan.
 */
export const decideBrowserStep = (
  input: BrowserStepGateInput,
): BrowserStepDecision => {
  const { command } = input;
  switch (command.action) {
    case BROWSER_CONTROL_ACTION.open:
    case BROWSER_CONTROL_ACTION.snapshot:
    case BROWSER_CONTROL_ACTION.find:
    case BROWSER_CONTROL_ACTION.goBack:
    case BROWSER_CONTROL_ACTION.switchTab:
      return RUNS_BY_LEVEL;
    case BROWSER_CONTROL_ACTION.click:
    case BROWSER_CONTROL_ACTION.fill:
    case BROWSER_CONTROL_ACTION.pressKey:
    case BROWSER_CONTROL_ACTION.select:
      return elementStepDecision(command, input);
    default:
      command satisfies never;
      return panic("Unhandled browser command");
  }
};
