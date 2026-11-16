import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { AI_ERROR_KINDS } from "@stll/api-contract/ai-errors";
import { CHAT_TOOL_LABELS } from "@stll/api-contract/chat-tool-activity";
import { UI_LOCALES } from "@stll/locales";

import { CHAT_FAILURE_KEYS } from "@/state/chat-failure";

import { CATALOGS } from "./catalogs";
import type { MobileMessages } from "./catalogs";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");

/** The web's catalogue for a locale, read as the web ships it. */
const webCatalog = (locale: string): unknown =>
  JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "apps/web/src/i18n/langs", `${locale}.json`),
      "utf-8",
    ),
  );

const nodeSchema = v.record(v.string(), v.unknown());

/** The message at `keys` in a catalogue, or undefined. */
const at = (catalog: unknown, keys: readonly string[]): unknown => {
  let node = catalog;
  for (const key of keys) {
    const parsed = v.safeParse(nodeSchema, node);
    node = parsed.success ? parsed.output[key] : undefined;
  }
  return node;
};

/** Titles the web keeps outside `chat.tool` (`getChatToolTitleKey`). */
const WEB_TITLE_KEYS: Readonly<Record<string, readonly string[]>> = {
  list_connectable_connectors: ["catalogue", "filter", "mcps"],
  show_visual: ["chat", "generatedView"],
  "skill-edit": ["common", "edit"],
};

/**
 * Where the web keeps each phrase of a coding agent's own steps: the title
 * of each kind, the sentences that place a value, a subagent's status, and
 * what a step's stored content says as it opens.
 */
const WEB_LOCAL_RUN_KEYS = {
  title: {
    sign_in: ["chat", "toolCall", "signInToContinue"],
    read: ["chat", "toolCall", "readFile"],
    search: ["chat", "toolCall", "searchFiles"],
    fetch: ["chat", "tool", "fetch_url"],
    plan: ["chat", "toolCall", "updatePlan"],
    proposed_plan: ["chat", "toolCall", "proposedPlan"],
    subagent: ["chat", "toolCall", "subagent"],
    image: ["chat", "toolCall", "viewImage"],
  },
  patternInPath: ["chat", "toolCall", "patternInPath"],
  commandExited: ["chat", "toolCall", "commandExited"],
  browserClick: ["chat", "toolCall", "browserClick"],
  browserType: ["chat", "toolCall", "browserType"],
  browserPressKey: ["chat", "toolCall", "browserPressKey"],
  browserSelect: ["chat", "toolCall", "browserSelect"],
  status: {
    needs_approval: ["chat", "turnStatus", "waitingForApproval"],
    running: ["tasks", "statusValues", "in_progress"],
    failed: ["common", "failed"],
    interrupted: ["chat", "stopped"],
  },
  output: {
    command: ["chat", "toolCall", "output"],
    diff: ["chat", "toolCall", "localOutput", "diff"],
    conversation: ["chat", "toolCall", "localOutput", "conversation"],
    conversationPrompt: [
      "chat",
      "toolCall",
      "localOutput",
      "conversationPrompt",
    ],
    conversationReport: [
      "chat",
      "toolCall",
      "localOutput",
      "conversationReport",
    ],
    cut: ["chat", "toolCall", "localOutput", "cut"],
    empty: ["chat", "toolCall", "localOutput", "empty"],
    arriving: ["chat", "toolCall", "localOutput", "arriving"],
    notCopied: ["chat", "toolCall", "localOutput", "notCopied"],
    notStored: ["chat", "toolCall", "localOutput", "notStored"],
    runBudgetReached: ["chat", "toolCall", "localOutput", "runBudgetReached"],
    imageTooLargeToStore: [
      "chat",
      "toolCall",
      "localOutput",
      "imageTooLargeToStore",
    ],
    loadFailed: ["common", "loadFailed"],
    showMore: ["common", "showMore"],
  },
  sessionNotResumed: ["chat", "localRun", "sessionNotResumed"],
  steered: ["chat", "tool", "user_message"],
} as const satisfies WebKeysOf<MobileMessages["chat"]["localRun"]>;

/** Where the web keeps the reason each failed turn gives (`AI_FAILURE_ERROR_KEYS`). */
const WEB_FAILURE_KEYS = {
  aiDeadlineExceeded: ["errors", "apiCodes", "aiDeadlineExceeded"],
  aiOutputInvalid: ["errors", "apiCodes", "aiOutputInvalid"],
  aiOutputModerated: ["errors", "apiCodes", "aiOutputModerated"],
  aiUnknown: ["errors", "apiCodes", "aiUnknown"],
  errorFolderUnavailable: ["chat", "localRun", "errorFolderUnavailable"],
  errorLimitReached: ["chat", "localRun", "errorLimitReached"],
  errorNeedsLogin: ["chat", "localRun", "errorNeedsLogin"],
  errorNotReached: ["chat", "localRun", "errorNotReached"],
  errorRelinked: ["chat", "localRun", "errorRelinked"],
  errorRestoring: ["chat", "localRun", "errorRestoring"],
  errorUnavailable: ["chat", "localRun", "errorUnavailable"],
  refusalFolderNotApproved: ["chat", "localRun", "refusalFolderNotApproved"],
  refusalHarnessUnavailable: ["chat", "localRun", "refusalHarnessUnavailable"],
  refusalModelUnavailable: ["chat", "localRun", "refusalModelUnavailable"],
  refusalNoComputer: ["chat", "localRun", "refusalNoComputer"],
  refusalPermissionUnavailable: [
    "chat",
    "localRun",
    "refusalPermissionUnavailable",
  ],
  refusalReasoningEffortUnavailable: [
    "chat",
    "localRun",
    "refusalReasoningEffortUnavailable",
  ],
  refusalTooLarge: ["chat", "localRun", "refusalTooLarge"],
  sendErrorEmptyCompletion: ["chat", "sendErrorEmptyCompletion"],
  sendErrorLoopDetected: ["chat", "sendErrorLoopDetected"],
  sendErrorModelUnavailable: ["chat", "sendErrorModelUnavailable"],
  sendErrorProviderBilling: ["chat", "sendErrorProviderBilling"],
  sendErrorProviderCredentialsRejected: [
    "chat",
    "sendErrorProviderCredentialsRejected",
  ],
  sendErrorProviderUnavailable: ["chat", "sendErrorProviderUnavailable"],
  sendErrorQuotaExhausted: ["chat", "sendErrorQuotaExhausted"],
  sendErrorStreamIncomplete: ["chat", "sendErrorStreamIncomplete"],
  sendErrorTurnTooLarge: ["chat", "sendErrorTurnTooLarge"],
} as const satisfies WebKeysOf<MobileMessages["chat"]["failure"]>;

/** A catalogue node with a web key path in place of each message. */
type WebKeysOf<TNode> = {
  readonly [K in keyof TNode]: TNode[K] extends string
    ? readonly string[]
    : WebKeysOf<TNode[K]>;
};

/** The web's message for each phrase, in the phone catalogue's shape. */
const webMessages = (web: unknown, keys: unknown): unknown =>
  Array.isArray(keys)
    ? at(web, keys)
    : Object.fromEntries(
        Object.entries(v.parse(nodeSchema, keys)).map(([key, node]) => [
          key,
          webMessages(web, node),
        ]),
      );

// A chat on the phone reads as the same chat on the web: each step under
// the title the web gives it, each run summed up in the web's words.
describe("an answer's steps", () => {
  test.each(UI_LOCALES)("are titled in %s as on the web", (locale) => {
    const web = webCatalog(locale);
    const { chat } = CATALOGS[locale];
    expect(Object.keys(chat.tool).toSorted()).toEqual(
      [...CHAT_TOOL_LABELS].toSorted(),
    );
    for (const [label, title] of Object.entries(chat.tool)) {
      expect({
        label,
        title: at(web, WEB_TITLE_KEYS[label] ?? ["chat", "tool", label]),
      }).toEqual({ label, title });
    }
    expect(at(web, ["chat", "processSummary"])).toEqual(chat.processSummary);
    expect(at(web, ["common", "stepCount"])).toBe(chat.stepCount);
    expect(at(web, ["chat", "reasoning"])).toBe(chat.reasoning);
    expect(at(web, ["chat", "historyTrimmed"])).toBe(chat.historyTrimmed);
    expect(webMessages(web, WEB_LOCAL_RUN_KEYS)).toEqual(chat.localRun);
  });
});

// A failed answer reads as on the web: the same reason for each kind of
// failure, under the web's button that sends the message again.
describe("a failed answer", () => {
  test.each(UI_LOCALES)("says why in %s as the web does", (locale) => {
    const web = webCatalog(locale);
    const { chat } = CATALOGS[locale];
    expect(webMessages(web, WEB_FAILURE_KEYS)).toEqual(chat.failure);
    expect(at(web, ["chat", "resend"])).toBe(chat.resend);
  });

  test("gives each failure kind the text the web gives it", () => {
    const webSource = readFileSync(
      path.join(REPO_ROOT, "apps/web/src/lib/errors/ai-failure.ts"),
      "utf-8",
    );
    for (const kind of AI_ERROR_KINDS) {
      const webKey = new RegExp(
        String.raw`\[AI_FAILURE_CODES\.${kind}\]:\s*"([\w.]+)"`,
        "u",
      ).exec(webSource)?.[1];
      expect({ kind, webKey }).toEqual({
        kind,
        webKey: WEB_FAILURE_KEYS[CHAT_FAILURE_KEYS[kind]].join("."),
      });
    }
  });
});

/** Where the web keeps each string of the phone's chat queue. */
const WEB_QUEUE_KEYS = {
  notice: ["chat", "queuedNotice"],
  prompt: ["chat", "queuePrompt"],
  sendNow: ["chat", "sendQueuedMessageNow"],
  remove: ["chat", "cancelQueuedMessage"],
  edit: ["common", "edit"],
  moveUp: ["common", "moveUp"],
  moveDown: ["common", "moveDown"],
  cancel: ["common", "cancel"],
  attachments: ["chat", "queuedAttachmentCount"],
  actions: ["chat", "queue", "actions"],
  notSent: ["chat", "queue", "notSent"],
  pause: ["chat", "queue", "pause"],
  resume: ["chat", "queue", "resume"],
  replaceTitle: ["chat", "queue", "replaceTitle"],
  replaceDescription: ["chat", "queue", "replaceDescription"],
  noLongerQueued: ["chat", "queue", "noLongerQueued"],
  held: {
    "turn-failed": ["chat", "queue", "heldTurnFailed"],
    "turn-interrupted": ["chat", "queue", "heldTurnInterrupted"],
    member: ["chat", "queue", "heldByMember"],
    "send-refused": ["chat", "queue", "heldSendRefused"],
    "usage-limit": ["chat", "queue", "heldUsageLimit"],
    "computer-away": ["chat", "queue", "heldComputerAway"],
  },
} as const satisfies {
  readonly [Key in keyof MobileMessages["chat"]["queue"]]: unknown;
};

// The queue reads as on the web: the same notices, actions and reasons.
describe("a chat's queue", () => {
  test.each(UI_LOCALES)("is worded in %s as on the web", (locale) => {
    const web = webCatalog(locale);
    const { chat } = CATALOGS[locale];
    expect(webMessages(web, WEB_QUEUE_KEYS)).toEqual(chat.queue);
  });
});
