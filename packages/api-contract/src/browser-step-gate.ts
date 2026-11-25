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
 * Each level's answer per kind of step on an element. Reading, finding,
 * going back and switching between the chat's tabs never ask at any level,
 * so they have no row here; opening a page follows `BROWSER_LEVEL_NEW_SITE`.
 * Plan opens and reads only. A level added to the contract fails here until
 * its rule is set.
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

/**
 * Each level's answer for opening a page on a website the chat has not been
 * on (`visitedOrigins`) and the member does not always allow. A website the
 * chat has been on opens at every level.
 */
export const BROWSER_LEVEL_NEW_SITE = {
  plan: "run",
  ask: "ask",
  auto: "run",
  full_auto: "run",
} as const satisfies Record<DesktopRunnerApprovalMode, BrowserLevelGate>;

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
  /**
   * The exact origins (`browserSiteGrantOrigin`) of every page the browser
   * reported for this chat: pages it opened or read, never an address the
   * model wrote.
   */
  visitedOrigins: ReadonlySet<string>;
};

/**
 * Why the gate asks the member about a step: every question carries one,
 * so a card can always say why it asks, and whether always allowing the
 * website would answer the next such step.
 */
export const BROWSER_STEP_ASK_REASON = {
  /**
   * The member does not always allow the website, and nothing else holds
   * the step back: always allowing the website answers it. Every other
   * reason holds a step back whatever the member allows, so no website
   * approval may answer a question asked for it.
   */
  siteNotAllowed: "site_not_allowed",
  /** The address names no website a website approval can hold. */
  noSite: "no_site",
  /**
   * The step names a page the browser did not report as the tab's page:
   * nothing was reported yet, the latest step did not settle on a page, or
   * the step was written for an earlier read.
   */
  pageUnconfirmed: "page_unconfirmed",
  /**
   * The element sits in a frame embedded in the page, which may show
   * another website than the one the page's address names.
   */
  embeddedFrame: "embedded_frame",
  /**
   * Typing into a field the browser reported no value for: the browser
   * withholds the value of every field it treats as secret.
   */
  possibleSecret: "possible_secret",
} as const;

export type BrowserStepAskReason =
  (typeof BROWSER_STEP_ASK_REASON)[keyof typeof BROWSER_STEP_ASK_REASON];

export const BROWSER_STEP_ASK_REASONS = Object.values(
  BROWSER_STEP_ASK_REASON,
) satisfies readonly BrowserStepAskReason[];

export type BrowserStepDecision =
  | { type: typeof BROWSER_STEP_GATE.run; by: "level" }
  /** A website approval for `origin` answered the step. */
  | { type: typeof BROWSER_STEP_GATE.run; by: "site-grant"; origin: string }
  /** The page opens on `origin`, a website the chat has already been on. */
  | { type: typeof BROWSER_STEP_GATE.run; by: "visited"; origin: string }
  /**
   * `site` is the website the question names, by exact origin: the page
   * the step was written for. It is the website an "always allow on this
   * website" offer is for; null when it cannot hold an approval. `reason`
   * says why the member is asked.
   */
  | {
      type: typeof BROWSER_STEP_GATE.ask;
      site: string | null;
      reason: BrowserStepAskReason;
    }
  | { type: typeof BROWSER_STEP_GATE.refuse }
  | { type: typeof BROWSER_STEP_GATE.needsMember };

/** A question about a step on `site`, for `reason`. */
type BrowserStepAsk = Extract<
  BrowserStepDecision,
  { type: typeof BROWSER_STEP_GATE.ask }
>;

const RUNS_BY_LEVEL: BrowserStepDecision = {
  type: BROWSER_STEP_GATE.run,
  by: "level",
};

/** The top frame's id in an element reference (`e:<frameId>:<path>`). */
const TOP_FRAME_ID = 0;

/**
 * Whether a website approval answers `command`, a step the level asks
 * about: only when the command names the very page the browser reported
 * last (address and revision), and the member always allows that page's
 * website. The target must sit in the top frame: a read merges every
 * controllable frame, including another website's embedded one, and names
 * only the top frame's address. Typing into a field the browser reported no
 * value for may be typing a secret, so no approval covers it. Otherwise the
 * question and why it is asked: what holds the step back whatever the
 * member allows comes first, so `siteNotAllowed` means an approval for the
 * website would answer the step.
 */
const siteGrantDecision = (
  command: BrowserControlElementCommand,
  page: BrowserReportedPage | null,
  grantedOrigins: ReadonlySet<string>,
): BrowserStepDecision => {
  const site = browserSiteGrantOrigin(command.page.url);
  const ask = (reason: BrowserStepAskReason): BrowserStepAsk => ({
    type: BROWSER_STEP_GATE.ask,
    site,
    reason,
  });
  if (site === null) {
    return ask(BROWSER_STEP_ASK_REASON.noSite);
  }
  if (
    page === null ||
    command.page.url !== page.url ||
    command.page.revision !== page.revision
  ) {
    return ask(BROWSER_STEP_ASK_REASON.pageUnconfirmed);
  }
  if (parseElementReference(command.target.ref)?.frameId !== TOP_FRAME_ID) {
    return ask(BROWSER_STEP_ASK_REASON.embeddedFrame);
  }
  if (
    command.action === BROWSER_CONTROL_ACTION.fill &&
    !page.valueRefs.has(command.target.ref)
  ) {
    return ask(BROWSER_STEP_ASK_REASON.possibleSecret);
  }
  if (!grantedOrigins.has(site)) {
    return ask(BROWSER_STEP_ASK_REASON.siteNotAllowed);
  }
  return { type: BROWSER_STEP_GATE.run, by: "site-grant", origin: site };
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
    case BROWSER_STEP_GATE.ask:
      return siteGrantDecision(command, reportedPage, grantedOrigins);
    default:
      gate satisfies never;
      return panic("Unhandled browser level gate");
  }
};

/**
 * Opening a page: the one step whose address the model writes, so the
 * address itself is what the member may be asked about. It opens without
 * asking on a website the chat has already been on or the member always
 * allows; otherwise the level decides (`BROWSER_LEVEL_NEW_SITE`). An address
 * that names no website a grant can hold is never one the chat has been on.
 */
const openStepDecision = ({
  command,
  grantedOrigins,
  level,
  visitedOrigins,
}: BrowserStepGateInput & {
  command: Extract<
    BrowserControlCommand,
    { action: typeof BROWSER_CONTROL_ACTION.open }
  >;
}): BrowserStepDecision => {
  const origin = browserSiteGrantOrigin(command.url);
  if (origin !== null && visitedOrigins.has(origin)) {
    return { type: BROWSER_STEP_GATE.run, by: "visited", origin };
  }
  const gate = BROWSER_LEVEL_NEW_SITE[level];
  switch (gate) {
    case BROWSER_STEP_GATE.run:
      return RUNS_BY_LEVEL;
    case BROWSER_STEP_GATE.ask:
      if (origin === null) {
        return {
          type: BROWSER_STEP_GATE.ask,
          site: null,
          reason: BROWSER_STEP_ASK_REASON.noSite,
        };
      }
      return grantedOrigins.has(origin)
        ? { type: BROWSER_STEP_GATE.run, by: "site-grant", origin }
        : {
            type: BROWSER_STEP_GATE.ask,
            site: origin,
            reason: BROWSER_STEP_ASK_REASON.siteNotAllowed,
          };
    default:
      gate satisfies never;
      return panic("Unhandled browser level gate");
  }
};

/**
 * Whether a browser step runs, asks, is refused or goes to the member.
 *
 * - Opening a page runs on a website the chat has already been on, or one
 *   the member always allows; on any other website the level decides
 *   (`BROWSER_LEVEL_NEW_SITE`): Ask asks first.
 * - Reading, finding, going back and switching to another of the chat's
 *   tabs run at every level: they read pages or return to a page a tab of
 *   the chat already shows, never an address the model wrote.
 * - A step on an element of a page the browser handed to the member for a
 *   sign-in goes to the member at every level.
 * - Otherwise the level decides by the kind of step (`BROWSER_LEVEL_GATES`).
 *   A step the level would ask about runs without asking when the member
 *   always allows the website the browser reported the step acts on
 *   (`siteGrantDecision`). A website approval never lifts Plan.
 */
export const decideBrowserStep = (
  input: BrowserStepGateInput,
): BrowserStepDecision => {
  const { command } = input;
  switch (command.action) {
    case BROWSER_CONTROL_ACTION.open:
      return openStepDecision({ ...input, command });
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
