import type { UIMessage } from "@tanstack/ai-client";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import fc from "fast-check";

import { getOutputTokenLimit } from "@stll/ai-catalog";
import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createForkThread } from "@/api/handlers/chat/fork/create";
import type { CreateDocumentToolOutput } from "@/api/handlers/chat/tools/create-document-tool";
import {
  ASK_USER_TOOL_NAME,
  CREATE_DOCUMENT_TOOL_NAME,
} from "@/api/handlers/chat/tools/native-chat-tool-names";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  APPROVAL_TOOL_NAME,
  approvalToolArguments,
  createApprovalHarness,
  HARNESS_CHAT_MODEL_ID,
  PLAIN_TOOL_ARGUMENTS,
  PLAIN_TOOL_NAME,
} from "@/api/tests/helpers/chat-approval-harness";
import type { ChatHarness } from "@/api/tests/helpers/chat-approval-harness";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type { OracleViolation } from "@/api/tests/helpers/chat-oracles";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";
import { findOfferedInteractions } from "@/api/tests/helpers/chat-thread-invariants";
import { loadWebChat } from "@/api/tests/helpers/chat-web-client";
import type { WebChatClient } from "@/api/tests/helpers/chat-web-client";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Whole conversations driven through the production path from both ends: the
// web app's own chat runtime posts what its live view holds and answers only
// the cards that view shows, the real `send-message` and `streamChat` serve
// it, and only the model is scripted. After every step the stored thread, the
// wire, and the live view against a reload must hold every oracle, and the
// conversation must match an independent ledger of what the model asked and
// what the user answered, so both views losing the same call still fails. A
// second tab on the same thread answers cards that went stale and races the
// first tab for the same approval.

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

const newThread = (): SafeId<"chatThread"> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  return threadId;
};

const ASK_USER_ARGUMENTS = JSON.stringify({
  analysis: "The draft depends on the side the user represents.",
  questions: [{ question: "Which side?", reason: "It decides the draft." }],
});
const ASK_USER_ANSWER = {
  answers: [{ answer: "Buyer", question: "Which side?" }],
};
const DRAFT_ARGUMENTS = JSON.stringify({
  name: "Mutual NDA",
  source: "@title Mutual NDA\n\nThe parties keep each other's information.",
});
/** What the page posts once it has handed a drafted document to the user. */
const DRAFT_RESULT = {
  destination: "download",
  fileName: "Mutual NDA.docx",
  success: true,
} as const satisfies CreateDocumentToolOutput;

/**
 * What a model call asks for: a server call the loop runs at once, an
 * approval card, an ask-user card, or a client call the page answers on its
 * own, with no card (a drafted document).
 */
type CallKind = "approval" | "ask-user" | "client" | "plain";
type StepShape = {
  calls: CallKind[];
  /** Read only on a step without calls: the answer hit the output limit. */
  cutOff: boolean;
  reasoning: boolean;
  text: boolean;
};
/** How a provider call fails before any output: it throws, or it reports
 *  the error in the stream. */
type FailureShape = "fail" | "report-error";
/** A model run: its steps, or a provider call that fails before any output. */
type RunShape = StepShape[] | FailureShape;

const isFailure = (shape: RunShape): shape is FailureShape =>
  shape === "fail" || shape === "report-error";
/**
 * How the user answers an approval card. `approve-all` approves it and then
 * every approval card that appears later in the conversation, each one
 * clicked on the page like any other approval.
 */
type Decision = "approve" | "approve-all" | "deny";

const isInteraction = (kind: CallKind): boolean => kind !== "plain";
/** Whether the call waits on a card the user answers. */
const hasCard = (kind: CallKind): boolean =>
  kind === "approval" || kind === "ask-user";

// --- The ledger ------------------------------------------------------------

type LedgerCall = {
  id: string;
  kind: CallKind;
  /** The user turn (and so the assistant message) the call belongs to. */
  turn: number;
};

/**
 * What the conversation must look like, kept apart from every view of it:
 * the calls the thread holds, the interactions still open, the approved calls
 * whose effect must have run exactly once, how the latest turn ended, and
 * whether the user now approves every approval card as it appears.
 */
type Ledger = {
  calls: LedgerCall[];
  effects: string[];
  /** Provider failures planned so far; each one is an error the page shows. */
  failures: number;
  approvesAll: boolean;
  /** How the latest turn ended; `cancelled` when the user stopped it or a
   *  fork settled what it awaited. */
  latest: "awaiting" | "cancelled" | "failed" | "none" | "text";
  /** How each turn stood when the conversation last settled. */
  outcomes: Map<number, Ledger["latest"]>;
  pending: string[];
  turn: number;
  /** What each turn still waited on when the conversation last settled. */
  waiting: Map<number, CallKind[]>;
};

const newLedger = (): Ledger => ({
  calls: [],
  effects: [],
  failures: 0,
  approvesAll: false,
  latest: "none",
  outcomes: new Map(),
  pending: [],
  turn: 0,
  waiting: new Map(),
});

const TEXT_ANSWER: RunShape = [
  { calls: [], cutOff: false, reasoning: false, text: true },
];

const scriptedCall = (kind: CallKind, toolCallId: string) => {
  switch (kind) {
    case "approval": {
      return {
        arguments: approvalToolArguments(toolCallId),
        toolCallId,
        toolName: APPROVAL_TOOL_NAME,
      };
    }
    case "ask-user": {
      return {
        arguments: ASK_USER_ARGUMENTS,
        toolCallId,
        toolName: ASK_USER_TOOL_NAME,
      };
    }
    case "client": {
      return {
        arguments: DRAFT_ARGUMENTS,
        toolCallId,
        toolName: CREATE_DOCUMENT_TOOL_NAME,
      };
    }
    case "plain": {
      return {
        arguments: PLAIN_TOOL_ARGUMENTS,
        toolCallId,
        toolName: PLAIN_TOOL_NAME,
      };
    }
    default: {
      return kind satisfies never;
    }
  }
};

/**
 * Scripts one model run and records it in the ledger: a step with only plain
 * calls runs them and calls the model again, a step with interactions ends the
 * run waiting on them, a step without calls answers in text, and a failing
 * run ends the turn failed.
 */
const planRun = (
  ledger: Ledger,
  shape: RunShape,
  nextId: () => string,
): ScriptedTurn[] => {
  if (isFailure(shape)) {
    ledger.failures += 1;
    ledger.pending = [];
    ledger.latest = "failed";
    return [
      shape === "fail"
        ? { message: "Scripted provider failure", type: "fail-before-output" }
        : { message: "Scripted provider error", type: "error" },
    ];
  }
  const steps: ScriptedTurn[] = [];
  for (const step of shape) {
    const label = nextId();
    const toolCalls = step.calls.map((kind) => {
      const toolCallId = nextId();
      ledger.calls.push({ id: toolCallId, kind, turn: ledger.turn });
      return scriptedCall(kind, toolCallId);
    });
    const answers = toolCalls.length === 0;
    steps.push({
      type: "step",
      ...(step.reasoning ? { reasoning: `Thinking ${label}` } : {}),
      ...(step.text || answers ? { text: `Answer ${label}` } : {}),
      ...(answers && step.cutOff ? { finishReason: "length" } : {}),
      toolCalls,
    });
    if (step.calls.some(isInteraction)) {
      ledger.pending = toolCalls.flatMap(({ toolCallId }, index) =>
        isInteraction(step.calls[index] ?? "plain") ? [toolCallId] : [],
      );
      ledger.latest = "awaiting";
      return steps;
    }
    if (answers) {
      ledger.pending = [];
      ledger.latest = "text";
      return steps;
    }
  }
  steps.push({ type: "step", text: `Answer ${nextId()}`, toolCalls: [] });
  ledger.pending = [];
  ledger.latest = "text";
  return steps;
};

const kindOf = (ledger: Ledger, id: string): CallKind =>
  ledger.calls.find((call) => call.id === id)?.kind ??
  expect.unreachable(`The ledger has no call ${id}`);

/**
 * Whether, after `approve-all`, the user approves every open card at once,
 * which sends the next request: when every open card is an approval. A page
 * that also waits on an ask-user is completed by the next resolve step. This
 * models the user's clicks, not the conversation grant
 * (`onAllowInConversation` and `AutomaticApprovalResponse` in the web
 * approval card): that runs in the React layer this harness does not render,
 * and the planned render-layer test covers it.
 */
const approvesAllOpen = (ledger: Ledger): boolean =>
  ledger.approvesAll &&
  ledger.pending.length > 0 &&
  ledger.pending.every((id) => kindOf(ledger, id) === "approval");

/**
 * Plans the requests one user step leads to: the first answers with `runs[0]`,
 * then one more for every round `approve-all` approves at once.
 * A request the step brought no run for answers in text.
 */
const planRequests = (
  ledger: Ledger,
  runs: readonly RunShape[],
  nextId: () => string,
): ScriptedTurn[][] => {
  const planned = [planRun(ledger, runs[0] ?? TEXT_ANSWER, nextId)];
  while (approvesAllOpen(ledger)) {
    ledger.effects.push(...ledger.pending);
    planned.push(planRun(ledger, runs[planned.length] ?? TEXT_ANSWER, nextId));
  }
  return planned;
};

// --- The system under test ------------------------------------------------

type Real = {
  client: WebChatClient;
  harness: ChatHarness;
  ledger: Ledger;
  nextId: () => string;
  threadId: SafeId<"chatThread">;
};

/** What command preconditions read: the ledger, never a (possibly broken)
 *  view. */
type Model = {
  latest: Ledger["latest"];
  pendingKinds: CallKind[];
  /** The user turns so far, each with its one answer. */
  turn: number;
  /** What each turn still waited on when the conversation last settled. */
  waiting: ReadonlyMap<number, readonly CallKind[]>;
};

/** A client call the page still runs keeps the turn running: the composer
 *  shows Stop and queues what the user sends. */
const isBusy = (model: Readonly<Model>): boolean =>
  model.pendingKinds.includes("client");

/** After `approve-all`, approves the approval cards on screen, one click
 *  each, round after round, until the round the ledger leaves open: one that
 *  also waits on an ask-user card or a client call. */
const approveCardsOnScreen = async (real: Real) => {
  const { ledger } = real;
  const openCards = ledger.pending.filter((id) => hasCard(kindOf(ledger, id)));
  for (let round = 0; round < 10; round += 1) {
    const cards = real.client.cards();
    if (
      !ledger.approvesAll ||
      cards.length === 0 ||
      !cards.every((card) => card.kind === "approval") ||
      sorted(cards.map(({ toolCallId }) => toolCallId)) === sorted(openCards)
    ) {
      return;
    }
    for (const card of cards) {
      await real.client.approve(card.toolCallId, true);
    }
  }
};

const toolCallIdsOf = (messages: readonly UIMessage[]): string[] =>
  messages.flatMap(({ parts }) =>
    parts.flatMap((part) => (part.type === "tool-call" ? [part.id] : [])),
  );

const sorted = (values: readonly string[]) => JSON.stringify(values.toSorted());

/** The ledger's oracles for the conversation as it now stands. */
const findLedgerViolations = async (real: Real): Promise<OracleViolation[]> => {
  const { harness, ledger, threadId } = real;
  const [offered, reload] = await Promise.all([
    findOfferedInteractions({ db: testDb, threadId }),
    harness.reloadView(threadId),
  ]);
  const onScreen = real.client.cards().map(({ toolCallId }) => toolCallId);
  const stored = offered.map(({ toolCallId }) => toolCallId);
  const expectedCalls = ledger.calls.map(({ id }) => id);
  const expectedCards = ledger.pending.filter((id) =>
    hasCard(kindOf(ledger, id)),
  );
  const live = toolCallIdsOf(real.client.messages());
  const reloaded = toolCallIdsOf(reload);
  const pendingMatches =
    JSON.stringify(onScreen) === JSON.stringify(expectedCards) &&
    sorted(stored) === sorted(ledger.pending);
  const callsMatch =
    JSON.stringify(live) === JSON.stringify(expectedCalls) &&
    JSON.stringify(reloaded) === JSON.stringify(expectedCalls);
  return [
    ...violationsOf(
      CHAT_ORACLE.ledgerPending,
      pendingMatches ? [] : [{ expected: ledger.pending, onScreen, stored }],
    ),
    ...violationsOf(
      CHAT_ORACLE.ledgerCallsPresent,
      callsMatch ? [] : [{ expected: expectedCalls, live, reloaded }],
    ),
    ...violationsOf(
      CHAT_ORACLE.ledgerEffectsAuthorized,
      sorted(harness.executions) === sorted(ledger.effects)
        ? []
        : [{ executed: harness.executions, expected: ledger.effects }],
    ),
  ];
};

const syncModel = (model: Model, ledger: Ledger) => {
  const pendingKinds = ledger.pending.map((id) => kindOf(ledger, id));
  ledger.outcomes.set(ledger.turn, ledger.latest);
  ledger.waiting.set(ledger.turn, pendingKinds);
  model.latest = ledger.latest;
  model.pendingKinds = pendingKinds;
  model.turn = ledger.turn;
  model.waiting = new Map(ledger.waiting);
};

/**
 * Every oracle after a step, with the signals the step is meant to raise;
 * the model then mirrors the ledger.
 */
const verify = async (
  model: Model,
  real: Real,
  expected: { failuresBefore: number },
) => {
  const violations = [
    ...(await real.harness.checkWebClient({
      client: real.client,
      expected: { runFailure: real.ledger.failures > expected.failuresBefore },
      threadId: real.threadId,
    })),
    ...(await findLedgerViolations(real)),
  ];
  expect(violations).toEqual([]);
  syncModel(model, real.ledger);
  expect(await findUncoveredActions(model, real)).toEqual([]);
};

/** The oracles a page left behind by another tab still owes: its own
 *  request refused, and nothing stored or run on its account. */
const STALE_PAGE_ORACLES = new Set<string>([
  CHAT_ORACLE.clientNoErrors,
  CHAT_ORACLE.clientRequestsAccepted,
  CHAT_ORACLE.persistedCallsSettled,
  CHAT_ORACLE.persistedPendingOwned,
  CHAT_ORACLE.persistedTurnSettles,
  CHAT_ORACLE.providerScriptsConsumed,
  CHAT_ORACLE.wireSnapshotIdentity,
]);

/**
 * Checks `page` for what a refused page owes. `refusedElsewhere` is set when
 * another page reported the refusal instead, as the loser of a race may be
 * either page.
 */
const checkStalePage = async (
  real: Real,
  page: WebChatClient,
  refusedElsewhere = false,
) => {
  const findings = await real.harness.checkWebClient({
    client: page,
    expected: { refusal: true },
    threadId: real.threadId,
  });
  expect(
    findings.filter(
      ({ detail, oracle }) =>
        STALE_PAGE_ORACLES.has(oracle) &&
        !(
          refusedElsewhere &&
          oracle === CHAT_ORACLE.clientNoErrors &&
          typeof detail === "object" &&
          detail !== null &&
          "expectedError" in detail
        ),
    ),
  ).toEqual([]);
};

// --- Commands --------------------------------------------------------------

class SendUserMessage implements fc.AsyncCommand<Model, Real> {
  static readonly allows = (model: Readonly<Model>) =>
    model.pendingKinds.length === 0;
  readonly runs: readonly RunShape[];
  readonly text: string;
  constructor(runs: readonly RunShape[], text: string) {
    this.runs = runs;
    this.text = text;
  }
  check = SendUserMessage.allows;
  run = async (model: Model, real: Real) => {
    const failuresBefore = real.ledger.failures;
    real.ledger.turn += 1;
    real.harness.script(
      real.threadId,
      ...planRequests(real.ledger, this.runs, real.nextId),
    );
    await real.client.sendUserMessage(Bun.randomUUIDv7(), this.text);
    await approveCardsOnScreen(real);
    await verify(model, real, { failuresBefore });
  };
  toString = () => `SendUserMessage(${JSON.stringify(this.runs)})`;
}

/** Records the user's answers to the open cards in the ledger, and the
 *  page's own results for its client calls. */
const decideBatch = (ledger: Ledger, decisions: readonly Decision[]) =>
  ledger.pending.map((id, index) => {
    if (kindOf(ledger, id) === "ask-user") {
      return { decision: "answer" as const, id };
    }
    if (kindOf(ledger, id) === "client") {
      return { decision: "run" as const, id };
    }
    const decision = ledger.approvesAll
      ? "approve"
      : (decisions[index % decisions.length] ?? "approve");
    if (decision === "approve-all") {
      ledger.approvesAll = true;
    }
    if (decision !== "deny") {
      ledger.effects.push(id);
    }
    return { decision, id };
  });

/** Answers every open card on `page` as `batch` decided. */
const answerBatch = async (
  page: WebChatClient,
  batch: ReturnType<typeof decideBatch>,
) => {
  for (const { decision, id } of batch) {
    switch (decision) {
      case "answer": {
        await page.answer(id, ASK_USER_ANSWER);
        break;
      }
      case "run": {
        await page.runClientTool(id, CREATE_DOCUMENT_TOOL_NAME, DRAFT_RESULT);
        break;
      }
      case "approve":
      case "approve-all":
      case "deny": {
        await page.approve(id, decision !== "deny");
        break;
      }
      default: {
        decision satisfies never;
      }
    }
  }
};

/** Resolves the open cards on the first tab and scripts what follows. */
const resolveOnFirstTab = async (
  real: Real,
  decisions: readonly Decision[],
  continuations: readonly RunShape[],
) => {
  const batch = decideBatch(real.ledger, decisions);
  real.harness.script(
    real.threadId,
    ...planRequests(real.ledger, continuations, real.nextId),
  );
  await answerBatch(real.client, batch);
  await approveCardsOnScreen(real);
  return batch;
};

class ResolveCards implements fc.AsyncCommand<Model, Real> {
  static readonly allows = (model: Readonly<Model>) =>
    model.pendingKinds.length > 0;
  readonly continuations: readonly RunShape[];
  readonly decisions: readonly Decision[];
  constructor(
    decisions: readonly Decision[],
    continuations: readonly RunShape[],
  ) {
    this.continuations = continuations;
    this.decisions = decisions;
  }
  check = ResolveCards.allows;
  run = async (model: Model, real: Real) => {
    const failuresBefore = real.ledger.failures;
    await resolveOnFirstTab(real, this.decisions, this.continuations);
    await verify(model, real, { failuresBefore });
  };
  toString = () =>
    `ResolveCards(${JSON.stringify(this.decisions)}, ${JSON.stringify(this.continuations)})`;
}

/**
 * The user types a new message while cards still wait. The message supersedes
 * the awaited interactions: none of them is offered any more, none of their
 * effects ever runs, and the new turn proceeds as any other. A client call
 * still waiting keeps the page busy, so the composer queues instead.
 */
class SupersedeCards implements fc.AsyncCommand<Model, Real> {
  static readonly allows = (model: Readonly<Model>) =>
    model.pendingKinds.length > 0 && !isBusy(model);
  readonly runs: readonly RunShape[];
  readonly text: string;
  constructor(runs: readonly RunShape[], text: string) {
    this.runs = runs;
    this.text = text;
  }
  check = SupersedeCards.allows;
  run = async (model: Model, real: Real) => {
    const failuresBefore = real.ledger.failures;
    real.ledger.pending = [];
    real.ledger.turn += 1;
    real.harness.script(
      real.threadId,
      ...planRequests(real.ledger, this.runs, real.nextId),
    );
    await real.client.sendUserMessage(Bun.randomUUIDv7(), this.text);
    await approveCardsOnScreen(real);
    await verify(model, real, { failuresBefore });
  };
  toString = () => `SupersedeCards(${JSON.stringify(this.runs)})`;
}

/** The thread's answers, oldest first: one per user turn. */
const answerIdsOf = async (real: Real): Promise<SafeId<"chatMessage">[]> =>
  (await real.harness.readThreadMessages(real.threadId)).flatMap(
    ({ id, role }) =>
      role === "assistant" ? [toSafeId<"chatMessage">(id)] : [],
  );

/**
 * "Fork from here" on an answer, which the page offers on every answer but
 * a running latest one. The fork holds the thread up to that answer, with
 * whatever it still awaited settled, and the user continues there.
 */
class ForkFrom implements fc.AsyncCommand<Model, Real> {
  static readonly allows = (model: Readonly<Model>) =>
    model.turn > (isBusy(model) ? 1 : 0);
  readonly pick: number;
  constructor(pick: number) {
    this.pick = pick;
  }
  check = ForkFrom.allows;
  /** The turn whose answer the fork is taken from. */
  targetTurn = (model: Readonly<Model>): number =>
    (this.pick % (isBusy(model) ? model.turn - 1 : model.turn)) + 1;
  run = async (model: Model, real: Real) => {
    const { ledger } = real;
    const failuresBefore = ledger.failures;
    const turn = this.targetTurn(model);
    const answers = await answerIdsOf(real);
    // The fixture must reach the fault: one answer per turn.
    expect(answers).toHaveLength(ledger.turn);
    const upToMessageId =
      answers.at(turn - 1) ?? expect.unreachable(`No answer for turn ${turn}`);
    const forkThreadId = newThread();
    const forked = await createForkThread({
      indexChatThread: async () => undefined,
    }).handler(
      asTestRaw<Parameters<ReturnType<typeof createForkThread>["handler"]>[0]>({
        body: { newThreadId: forkThreadId, upToMessageId },
        getWorkspaceAccess: async () => null,
        memberRole: { role: "owner" },
        params: { threadId: real.threadId },
        query: {},
        recordAuditEvent: async () => undefined,
        request: new Request("http://localhost/v1/chat/threads/fork"),
        safeDb,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
      }),
    );
    expect(forked).toMatchObject({ threadId: forkThreadId });
    const outcome =
      turn === ledger.turn ? ledger.latest : ledger.outcomes.get(turn);
    ledger.calls = ledger.calls.filter((call) => call.turn <= turn);
    for (const later of [...ledger.waiting.keys()].filter((t) => t > turn)) {
      ledger.waiting.delete(later);
    }
    ledger.pending = [];
    ledger.latest =
      outcome === undefined || outcome === "awaiting" ? "cancelled" : outcome;
    ledger.turn = turn;
    real.client.dispose();
    real.threadId = forkThreadId;
    real.client = await real.harness.openWebClient(forkThreadId);
    await verify(model, real, { failuresBefore });
  };
  toString = () => `ForkFrom(${String(this.pick)})`;
}

/**
 * The composer's Stop while the page still runs a client call: the call is
 * cancelled and the turn ends.
 */
class StopRunningCall implements fc.AsyncCommand<Model, Real> {
  static readonly allows = isBusy;
  check = StopRunningCall.allows;
  run = async (model: Model, real: Real) => {
    real.ledger.pending = [];
    real.ledger.latest = "cancelled";
    await real.client.stop();
    await verify(model, real, { failuresBefore: real.ledger.failures });
  };
  toString = () => "StopRunningCall";
}

/**
 * The user sends a message and stops the answer while it streams: after its
 * server call has streamed, or while the call's input still streams. The
 * call stays in the answer and nothing waits on the user.
 */
class StopMidStream implements fc.AsyncCommand<Model, Real> {
  static readonly allows = SendUserMessage.allows;
  readonly quietAt: "after-tool-end" | "before-tool-end";
  constructor(quietAt: "after-tool-end" | "before-tool-end") {
    this.quietAt = quietAt;
  }
  check = StopMidStream.allows;
  run = async (model: Model, real: Real) => {
    const { harness, ledger, threadId } = real;
    ledger.turn += 1;
    const toolCallId = real.nextId();
    ledger.calls.push({ id: toolCallId, kind: "plain", turn: ledger.turn });
    ledger.pending = [];
    ledger.latest = "cancelled";
    harness.streamLive(threadId);
    try {
      harness.script(threadId, [
        {
          quietUntilAborted: this.quietAt,
          text: "Checking the register",
          toolCalls: [
            {
              arguments: PLAIN_TOOL_ARGUMENTS,
              toolCallId,
              toolName: PLAIN_TOOL_NAME,
            },
          ],
          type: "step",
        },
      ]);
      await real.client.startUserMessage(
        Bun.randomUUIDv7(),
        "Check the register",
        (messages) =>
          messages.some(({ parts }) =>
            parts.some(
              (part) => part.type === "tool-call" && part.id === toolCallId,
            ),
          ),
      );
      await real.client.stop();
    } finally {
      harness.streamWhole(threadId);
    }
    await verify(model, real, { failuresBefore: ledger.failures });
  };
  toString = () => `StopMidStream(${this.quietAt})`;
}

/**
 * Any step, taken in a second tab on the thread: the first tab's view goes
 * stale, and the page rebuilds it from the server when the user returns to
 * it.
 */
class OnSecondTab implements fc.AsyncCommand<Model, Real> {
  readonly step: fc.AsyncCommand<Model, Real>;
  constructor(step: fc.AsyncCommand<Model, Real>) {
    this.step = step;
  }
  check = (model: Readonly<Model>) => this.step.check(model);
  run = async (model: Model, real: Real) => {
    const first = real.client;
    real.client = await real.harness.openWebClient(real.threadId);
    try {
      await this.step.run(model, real);
    } finally {
      real.client.dispose();
      first.dispose();
      real.client = await real.harness.openWebClient(real.threadId);
    }
    await verify(model, real, { failuresBefore: real.ledger.failures });
  };
  toString = () => `OnSecondTab(${String(this.step)})`;
}

class ReloadPage implements fc.AsyncCommand<Model, Real> {
  static readonly allows = () => true;
  check = ReloadPage.allows;
  run = async (model: Model, real: Real) => {
    real.client.dispose();
    real.client = await real.harness.openWebClient(real.threadId);
    await verify(model, real, { failuresBefore: real.ledger.failures });
  };
  toString = () => "ReloadPage";
}

/**
 * Retry on the latest answer, which the page offers whenever the thread ends
 * with an answer and no turn runs, cards waiting or not.
 */
class ResendLatest implements fc.AsyncCommand<Model, Real> {
  static readonly allows = (model: Readonly<Model>) =>
    model.turn > 0 && !isBusy(model);
  readonly runs: readonly RunShape[];
  constructor(runs: readonly RunShape[]) {
    this.runs = runs;
  }
  check = ResendLatest.allows;
  run = async (model: Model, real: Real) => {
    const { ledger } = real;
    const failuresBefore = ledger.failures;
    // The regenerated answer replaces the latest turn's message, and with it
    // the cards it still showed; what its approved calls did stays done.
    ledger.calls = ledger.calls.filter(({ turn }) => turn !== ledger.turn);
    ledger.pending = [];
    real.harness.script(
      real.threadId,
      ...planRequests(ledger, this.runs, real.nextId),
    );
    await real.client.resend();
    await approveCardsOnScreen(real);
    await verify(model, real, { failuresBefore });
  };
  toString = () => `ResendLatest(${JSON.stringify(this.runs)})`;
}

/**
 * A second tab loads while the approvals are open; the first tab resolves
 * them, then the user answers the same cards in the second tab. The second
 * tab's continuation is refused, nothing runs again, and the first tab stays
 * sound.
 */
class AnswerOnStaleTab implements fc.AsyncCommand<Model, Real> {
  readonly approved: boolean;
  readonly continuations: readonly RunShape[];
  readonly decisions: readonly Decision[];
  constructor(
    decisions: readonly Decision[],
    continuations: readonly RunShape[],
    approved: boolean,
  ) {
    this.approved = approved;
    this.continuations = continuations;
    this.decisions = decisions;
  }
  check = (model: Readonly<Model>) =>
    model.pendingKinds.length > 0 && model.pendingKinds.every(hasCard);
  run = async (model: Model, real: Real) => {
    const failuresBefore = real.ledger.failures;
    const cards = real.ledger.pending.map((id) => ({
      id,
      kind: kindOf(real.ledger, id),
    }));
    const stale = await real.harness.openWebClient(real.threadId);
    try {
      await resolveOnFirstTab(real, this.decisions, this.continuations);
      await verify(model, real, { failuresBefore });
      for (const { id, kind } of cards) {
        await (kind === "ask-user"
          ? stale.answer(id, ASK_USER_ANSWER)
          : stale.approve(id, this.approved));
      }
      await checkStalePage(real, stale);
    } finally {
      stale.dispose();
    }
    await verify(model, real, { failuresBefore: real.ledger.failures });
  };
  toString = () =>
    `AnswerOnStaleTab(${JSON.stringify(this.decisions)}, ${JSON.stringify(this.continuations)}, ${String(this.approved)})`;
}

/**
 * Two tabs show the same open approvals and the user approves them in both at
 * once: the approved calls run exactly once, one tab's continuation is
 * refused, and a page loaded afterwards is sound.
 */
class RaceApprovals implements fc.AsyncCommand<Model, Real> {
  check = (model: Readonly<Model>) =>
    model.pendingKinds.length > 0 &&
    model.pendingKinds.every((kind) => kind === "approval");
  run = async (model: Model, real: Real) => {
    const { ledger } = real;
    const failuresBefore = ledger.failures;
    const cards = [...ledger.pending];
    const other = await real.harness.openWebClient(real.threadId);
    try {
      ledger.effects.push(...cards);
      real.harness.script(
        real.threadId,
        ...planRequests(ledger, [TEXT_ANSWER], real.nextId),
      );
      const approveAll = async (page: WebChatClient) => {
        for (const id of cards) {
          await page.approve(id, true);
        }
      };
      await Promise.all([approveAll(real.client), approveAll(other)]);
      // Either page may lose; the first page's report counts for the pair.
      const firstPageErrors = real.client.takeErrors();
      await checkStalePage(real, other, firstPageErrors.length > 0);
    } finally {
      other.dispose();
    }
    // Whichever tab lost holds a refused view; the user reloads it.
    real.client.dispose();
    real.client = await real.harness.openWebClient(real.threadId);
    await verify(model, real, { failuresBefore });
  };
  toString = () => "RaceApprovals";
}

// --- Every action the page offers ------------------------------------------

/**
 * How the model performs each action the chat thread page offers
 * (`CHAT_USER_ACTIONS` in `apps/web/src/components/chat/chat-user-actions.ts`):
 * by the commands whose preconditions `allows` joins, which may not be
 * stricter than the page, or not at all, and why.
 */
type ActionCoverage =
  | {
      allows: (model: Readonly<Model>) => boolean;
      commands: string;
      type: "commands";
    }
  | { reason: string; type: "not-modelled" };

const byCommands = (
  commands: string,
  allows: (model: Readonly<Model>) => boolean,
): ActionCoverage => ({ allows, commands, type: "commands" });
const notModelled = (reason: string): ActionCoverage => ({
  reason,
  type: "not-modelled",
});
const READS_ONLY = notModelled("It reads the thread and changes nothing.");
const PAGE_STATE = notModelled(
  "It changes what the page sends next, not the conversation.",
);

const ACTION_COVERAGE: Record<string, ActionCoverage> = {
  "allow-in-conversation": byCommands(
    "ResolveCards (approve-all), AnswerOnStaleTab, RaceApprovals",
    ResolveCards.allows,
  ),
  "allow-once": byCommands(
    "ResolveCards, AnswerOnStaleTab, RaceApprovals",
    ResolveCards.allows,
  ),
  "always-allow": notModelled(
    "A grant kept in the browser's storage; the conversation sees the approval it answers with, as allow-once.",
  ),
  "answer-question": byCommands(
    "ResolveCards, AnswerOnStaleTab",
    ResolveCards.allows,
  ),
  "attach-files": notModelled(
    "The harness posts text messages only; attachments need stored files.",
  ),
  copy: READS_ONLY,
  "delete-thread": notModelled(
    "Deleting the thread ends the conversation; nothing is left to check.",
  ),
  deny: byCommands("ResolveCards, AnswerOnStaleTab", ResolveCards.allows),
  "edit-answer": notModelled(
    "Edit and rerun lives in the session hook, which the harness does not render.",
  ),
  export: READS_ONLY,
  fork: byCommands("ForkFrom", ForkFrom.allows),
  "improve-prompt": PAGE_STATE,
  "load-older": READS_ONLY,
  "move-to-side": PAGE_STATE,
  "new-chat": notModelled("It leaves the thread."),
  "open-created-document": READS_ONLY,
  "open-draft": READS_ONLY,
  "remove-queued-message": notModelled(
    "The send queue lives in the session hook, which the harness does not render.",
  ),
  "rename-thread": notModelled("It changes the title only."),
  "resend-without-anonymization": notModelled(
    "Offered only after the anonymization boundary refuses a turn, which the harness's raw boundary never does.",
  ),
  "resolve-draft": notModelled(
    "Saving a draft changes the stored document, not the conversation.",
  ),
  retry: byCommands("ResendLatest", ResendLatest.allows),
  "run-client-tool": byCommands("ResolveCards", ResolveCards.allows),
  "select-matters": PAGE_STATE,
  "select-model": notModelled(
    "The harness scripts one model; a model switch needs a second one.",
  ),
  // While a turn runs, the composer queues the message; the queue lives in
  // the session hook, which the harness does not render.
  send: byCommands(
    "SendUserMessage, StopMidStream, SupersedeCards",
    (model) =>
      SendUserMessage.allows(model) ||
      SupersedeCards.allows(model) ||
      isBusy(model),
  ),
  stop: byCommands("StopRunningCall, StopMidStream", StopRunningCall.allows),
  "toggle-anonymization": PAGE_STATE,
  "toggle-web-search": PAGE_STATE,
};

/**
 * The actions the page offers on the live view that the model's commands do
 * not allow: a precondition stricter than the page's.
 */
const findUncoveredActions = async (
  model: Readonly<Model>,
  real: Real,
): Promise<OracleViolation[]> => {
  const web = await loadWebChat();
  const messages = real.client.messages();
  const { hasError, requestActive } = real.client.runtimeState();
  const isGenerating = web.isChatTurnGenerating({
    hasError:
      hasError ||
      web.getChatAssistantTurnError(messages.at(-1) ?? null) !== undefined,
    messages,
    requestActive,
    sessionGenerating: false,
  });
  const answers = messages.filter(({ role }) => role === "assistant");
  const offeredOnAnswer = (gate: typeof web.canForkAssistantMessage): boolean =>
    answers.some(({ id }) => gate({ isGenerating, messageId: id, messages }));
  const cards = real.client.cards();
  const offered: Record<string, boolean> = {
    "allow-in-conversation": cards.some(({ kind }) => kind === "approval"),
    "allow-once": cards.some(({ kind }) => kind === "approval"),
    "answer-question": cards.some(({ kind }) => kind === "answer"),
    deny: cards.some(({ kind }) => kind === "approval"),
    fork: offeredOnAnswer(web.canForkAssistantMessage),
    retry: offeredOnAnswer(web.canRetryAssistantMessage),
    send: true,
    stop: isGenerating,
  };
  return violationsOf(
    CHAT_ORACLE.modelCoversPageActions,
    Object.entries(offered).flatMap(([action, isOffered]) => {
      const coverage = ACTION_COVERAGE[action];
      return isOffered &&
        coverage?.type === "commands" &&
        !coverage.allows(model)
        ? [{ action, commands: coverage.commands, model }]
        : [];
    }),
  );
};

// --- Generators -----------------------------------------------------------

/** A step's calls: server calls the loop runs at once, calls that wait on
 *  the user, or client calls the page answers on its own. */
const callsArb = fc.oneof(
  fc.array(fc.constant<CallKind>("plain"), { maxLength: 4 }),
  fc.array(fc.constantFrom<CallKind>("approval", "ask-user"), {
    maxLength: 4,
    minLength: 1,
  }),
  fc.array(fc.constant<CallKind>("client"), { maxLength: 2, minLength: 1 }),
);
/** A step's calls in any mix, as a model may make them. */
const mixedCallsArb = fc.array(
  fc.constantFrom<CallKind>("plain", "approval", "ask-user", "client"),
  { maxLength: 4, minLength: 1 },
);

/** The runs a step's requests answer with, built from steps whose calls
 *  `calls` shapes: its own, then the ones `approve-all` sends. */
const runsOf = (calls: fc.Arbitrary<CallKind[]>): fc.Arbitrary<RunShape[]> => {
  const stepArb: fc.Arbitrary<StepShape> = fc.record({
    calls,
    cutOff: fc.boolean(),
    reasoning: fc.boolean(),
    text: fc.boolean(),
  });
  const stepsArb: fc.Arbitrary<StepShape[]> = fc.array(stepArb, {
    maxLength: 3,
    minLength: 1,
  });
  // A model run: steps, or now and then a provider call that fails before
  // it answers.
  const runArb: fc.Arbitrary<RunShape> = fc.oneof(
    { arbitrary: stepsArb, weight: 5 },
    { arbitrary: fc.constant<RunShape>("fail"), weight: 1 },
  );
  return fc.array(runArb, { maxLength: 3, minLength: 1 });
};
const decisionsArb = fc.array(
  fc.constantFrom<Decision>("approve", "approve-all", "deny"),
  { maxLength: 4, minLength: 4 },
);

/** The steps of a conversation in one tab, and the races a second tab
 *  brings. */
const conversationCommandsOf = (runsArb: fc.Arbitrary<RunShape[]>) => [
  fc
    .tuple(runsArb, fc.constantFrom("Draft the NDA", "Continue"))
    .map(([runs, text]) => new SendUserMessage(runs, text)),
  fc
    .tuple(decisionsArb, runsArb)
    .map(
      ([decisions, continuations]) =>
        new ResolveCards(decisions, continuations),
    ),
  fc.constant(new ReloadPage()),
  runsArb.map((runs) => new ResendLatest(runs)),
  fc
    .tuple(decisionsArb, runsArb, fc.boolean())
    .map(
      ([decisions, continuations, approved]) =>
        new AnswerOnStaleTab(decisions, continuations, approved),
    ),
  fc.constant(new RaceApprovals()),
];
const conversationCommands = conversationCommandsOf(runsOf(callsArb));

/**
 * Every step the page offers: the conversation's own, over steps of any mix
 * of calls, and a fork, a Stop, a new message typed past waiting cards, and
 * any step taken in a second tab.
 */
const pageActionCommandsOf = (runsArb: fc.Arbitrary<RunShape[]>) => [
  ...conversationCommandsOf(runsArb),
  fc.nat({ max: 5 }).map((pick) => new ForkFrom(pick)),
  fc.constant(new StopRunningCall()),
  fc
    .constantFrom<"after-tool-end" | "before-tool-end">(
      "after-tool-end",
      "before-tool-end",
    )
    .map((quietAt) => new StopMidStream(quietAt)),
  fc
    .tuple(runsArb, fc.constantFrom("Use the buyer's form", "Start over"))
    .map(([runs, text]) => new SupersedeCards(runs, text)),
  fc
    .oneof(
      fc
        .tuple(runsArb, fc.constantFrom("Draft the NDA", "Continue"))
        .map(([runs, text]) => new SendUserMessage(runs, text)),
      fc
        .tuple(decisionsArb, runsArb)
        .map(
          ([decisions, continuations]) =>
            new ResolveCards(decisions, continuations),
        ),
      runsArb.map((runs) => new ResendLatest(runs)),
    )
    .map((step) => new OnSecondTab(step)),
];

const supersedeCommand = fc
  .tuple(
    runsOf(callsArb),
    fc.constantFrom("Use the buyer's form", "Start over"),
  )
  .map(([runs, text]) => new SupersedeCards(runs, text));

const openConversation = async () => {
  const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
  const threadId = newThread();
  let idCount = 0;
  const real: Real = {
    client: await harness.openWebClient(threadId),
    harness,
    ledger: newLedger(),
    nextId: () => {
      idCount += 1;
      return `call-${String(idCount)}`;
    },
    threadId,
  };
  const model: Model = {
    latest: "none",
    pendingKinds: [],
    turn: 0,
    waiting: new Map(),
  };
  return { model, real };
};

const closeConversation = ({ real }: { real: Real }) => {
  real.client.dispose();
  real.harness.close();
};

const runConversations = async (
  commands: fc.Arbitrary<Iterable<fc.AsyncCommand<Model, Real>>>,
) => {
  await fc.assert(
    fc.asyncProperty(commands, async (sequence) => {
      const conversation = await openConversation();
      try {
        await fc.asyncModelRun(() => conversation, sequence);
      } finally {
        closeConversation(conversation);
      }
    }),
    propertyConfig({ numRuns: 25, seed: propertySeed() }),
  );
};

// --- Cases the page does not handle yet -------------------------------------

/** Runs `steps` on a fresh conversation. */
const inConversation = async (
  steps: (model: Model, real: Real) => Promise<void>,
) => {
  const conversation = await openConversation();
  try {
    await steps(conversation.model, conversation.real);
  } finally {
    closeConversation(conversation);
  }
};

/** A message typed while an approval waits is posted and stored. */
const sendPastAnApproval = async () => {
  await inConversation(async (model, real) => {
    await new SendUserMessage(
      [[{ ...STEP, calls: ["approval"] }]],
      "Delete the NDA",
    ).run(model, real);
    real.harness.script(real.threadId, [
      { text: "Kept it", toolCalls: [], type: "step" },
    ]);
    await real.client.sendUserMessage(Bun.randomUUIDv7(), "Keep it");
    const users = (await real.harness.readThreadMessages(real.threadId)).filter(
      ({ role }) => role === "user",
    );
    expect({
      errors: real.client.takeErrors().map(String),
      users: users.length,
    }).toEqual({ errors: [], users: 2 });
  });
};

const replaceWaiting = async (calls: CallKind[]) => {
  await inConversation(async (model, real) => {
    await new SendUserMessage([[{ ...STEP, calls }]], "Draft the NDA").run(
      model,
      real,
    );
    // The fixture must reach the fault: every call still waits.
    expect(real.ledger.pending).toHaveLength(calls.length);
    await new SupersedeCards([TEXT_ANSWER], "Use the buyer's form").run(
      model,
      real,
    );
    await new ReloadPage().run(model, real);
  });
};

const resumeAfterReplacing = async () => {
  await inConversation(async (model, real) => {
    await new SendUserMessage(
      [[{ ...STEP, calls: ["ask-user", "approval"] }]],
      "Draft the NDA",
    ).run(model, real);
    await new SupersedeCards(
      [[{ ...STEP, calls: ["approval", "client"] }]],
      "Use the buyer's form",
    ).run(model, real);
    // The fixture must reach the fault: the replacing turn waits on its own
    // approval and client call.
    expect(model.pendingKinds).toEqual(["approval", "client"]);
    await new ResolveCards(["approve"], [TEXT_ANSWER]).run(model, real);
    expect(real.ledger.effects).toHaveLength(1);
    await new ReloadPage().run(model, real);
  });
};

const stopWhileStreaming = async (
  quietAt: "after-tool-end" | "before-tool-end",
) => {
  await inConversation(async (model, real) => {
    await new StopMidStream(quietAt).run(model, real);
    await new ReloadPage().run(model, real);
  });
};

const forkWhileAQuestionWaits = async () => {
  await inConversation(async (model, real) => {
    await new SendUserMessage(
      [[{ ...STEP, calls: ["ask-user"] }]],
      "Draft the NDA",
    ).run(model, real);
    await new ForkFrom(0).run(model, real);
    // The fixture must reach the fault: the fork settled the question.
    expect(model.pendingKinds).toEqual([]);
    await new SendUserMessage([TEXT_ANSWER], "Use the buyer's form").run(
      model,
      real,
    );
  });
};

const stopARunningClientCall = async () => {
  await inConversation(async (model, real) => {
    await new SendUserMessage(
      [[{ ...STEP, calls: ["client"] }]],
      "Draft the NDA",
    ).run(model, real);
    // The fixture must reach the fault: the page still runs the call.
    expect(model.pendingKinds).toEqual(["client"]);
    await new StopRunningCall().run(model, real);
    await new ReloadPage().run(model, real);
  });
};

/** The command a step performs, through any second tab it is taken in. */
const innermost = (
  command: fc.AsyncCommand<Model, Real>,
): fc.AsyncCommand<Model, Real> =>
  command instanceof OnSecondTab ? innermost(command.step) : command;

type OpenGap = {
  /** The steps the page-action property leaves out while this is open. */
  condition: string;
  excludes: (
    command: fc.AsyncCommand<Model, Real>,
    model: Readonly<Model>,
  ) => boolean;
  /** Fails while this is open. */
  reproduce: () => Promise<void>;
};

const isSupersede = (command: fc.AsyncCommand<Model, Real>) =>
  command instanceof SupersedeCards;

/**
 * Open findings, by id: each one's excluded steps and its failing case. The
 * ledger only shrinks: every case must still fail, an entry whose case
 * passes fails until it is removed, and its size is pinned to
 * OPEN_GAPS_SIZE, which only goes down.
 */
const OPEN_GAPS = {
  S1: {
    condition: "SupersedeCards",
    excludes: isSupersede,
    reproduce: sendPastAnApproval,
  },
  S2: {
    condition: "SupersedeCards",
    excludes: isSupersede,
    reproduce: async () => {
      await replaceWaiting(["ask-user"]);
    },
  },
  S3: {
    condition: "SupersedeCards whose runs end at a card",
    excludes: (command) =>
      command instanceof SupersedeCards &&
      command.runs.some(
        (run) =>
          !isFailure(run) && run.some(({ calls }) => calls.some(isInteraction)),
      ),
    reproduce: resumeAfterReplacing,
  },
  F2: {
    condition: "StopMidStream",
    excludes: (command) => command instanceof StopMidStream,
    reproduce: async () => {
      await stopWhileStreaming("after-tool-end");
      await stopWhileStreaming("before-tool-end");
    },
  },
  F3: {
    condition:
      "ForkFrom a turn that waits on an ask-user card or a client call",
    excludes: (command, model) =>
      command instanceof ForkFrom &&
      (model.waiting.get(command.targetTurn(model)) ?? []).some(
        (kind) => kind === "ask-user" || kind === "client",
      ),
    reproduce: forkWhileAQuestionWaits,
  },
  F5: {
    condition: "StopRunningCall",
    excludes: (command) => command instanceof StopRunningCall,
    reproduce: stopARunningClientCall,
  },
} as const satisfies Record<string, OpenGap>;

/** The ledger's size. Lower it with every entry removed; never raise it. */
const OPEN_GAPS_SIZE = 6;

/** A step the page-action property takes unless an open finding excludes
 *  it. */
class OutsideOpenGaps implements fc.AsyncCommand<Model, Real> {
  readonly command: fc.AsyncCommand<Model, Real>;
  constructor(command: fc.AsyncCommand<Model, Real>) {
    this.command = command;
  }
  check = (model: Readonly<Model>) =>
    this.command.check(model) &&
    !Object.values(OPEN_GAPS).some(({ excludes }) =>
      excludes(innermost(this.command), model),
    );
  run = async (model: Model, real: Real) => {
    await this.command.run(model, real);
  };
  toString = () => String(this.command);
}

const STEP: StepShape = {
  calls: [],
  cutOff: false,
  reasoning: false,
  text: false,
};

describe("a conversation's live view", () => {
  test(
    "keeps every card after an approval on a message that already holds a tool result",
    async () => {
      const conversation = await openConversation();
      const { model, real } = conversation;
      try {
        await new SendUserMessage(
          [
            [
              { ...STEP, calls: ["plain"] },
              { ...STEP, calls: ["approval"], text: true },
            ],
          ],
          "Draft the NDA",
        ).run(model, real);
        // The fixture must reach the fault: the owning message holds a tool
        // result before the approved call, so the engine splits it on replay.
        expect(real.ledger.pending).toHaveLength(1);

        await new ResolveCards(
          ["approve-all", "approve-all", "approve-all", "approve-all"],
          [[{ ...STEP, calls: ["approval"], text: true }]],
        ).run(model, real);
      } finally {
        closeConversation(conversation);
      }
    },
    propertyTestTimeout(30_000),
  );

  test(
    "keeps a denied call denied when the model then asks for another approval",
    async () => {
      const conversation = await openConversation();
      const { model, real } = conversation;
      try {
        await new SendUserMessage(
          [[{ ...STEP, calls: ["approval"] }]],
          "Delete the NDA",
        ).run(model, real);
        await new ResolveCards(
          ["deny"],
          [[{ ...STEP, calls: ["approval"], text: true }]],
        ).run(model, real);
        // The fixture must reach the fault: the denied call and the new request
        // share one message, which the next snapshot carries.
        expect(real.ledger.pending).toHaveLength(1);
        await new ReloadPage().run(model, real);
      } finally {
        closeConversation(conversation);
      }
    },
    propertyTestTimeout(30_000),
  );

  test(
    "accepts an approval of the call the model asks for after a denial",
    async () => {
      const conversation = await openConversation();
      const { model, real } = conversation;
      try {
        await new SendUserMessage(
          [[{ ...STEP, calls: ["approval"] }]],
          "Delete the NDA",
        ).run(model, real);
        await new ResolveCards(
          ["deny"],
          [[{ ...STEP, calls: ["approval"], text: true }]],
        ).run(model, real);
        // The fixture must reach the fault: a card for the model's next call
        // sits on the message that holds the denial.
        expect(real.ledger.pending).toHaveLength(1);
        await new ResolveCards(["approve"], [TEXT_ANSWER]).run(model, real);
        expect(real.ledger.effects).toHaveLength(1);
        await new ReloadPage().run(model, real);
      } finally {
        closeConversation(conversation);
      }
    },
    propertyTestTimeout(30_000),
  );

  const failsBeforeAnswering: [
    string,
    FailureShape,
    RunShape[] | null,
    Decision,
  ][] = [
    ["a new message", "fail", null, "approve"],
    ["an answer", "fail", [[{ ...STEP, calls: ["ask-user"] }]], "approve"],
    ["a new message", "report-error", null, "approve"],
    [
      "an answer",
      "report-error",
      [[{ ...STEP, calls: ["ask-user"] }]],
      "approve",
    ],
    ["a denial", "fail", [[{ ...STEP, calls: ["approval"] }]], "deny"],
    ["a denial", "report-error", [[{ ...STEP, calls: ["approval"] }]], "deny"],
  ];

  test.each(failsBeforeAnswering)(
    "keeps one message for the turn when the model fails before answering %s (%s)",
    async (_label, failure, first, decision) => {
      const conversation = await openConversation();
      const { model, real } = conversation;
      try {
        if (first === null) {
          await new SendUserMessage([failure], "Draft the NDA").run(
            model,
            real,
          );
        } else {
          await new SendUserMessage(first, "Draft the NDA").run(model, real);
          await new ResolveCards([decision], [failure]).run(model, real);
        }
        // The fixture must reach the fault: the model call failed.
        expect(real.ledger.latest).toBe("failed");
        await new ReloadPage().run(model, real);
      } finally {
        closeConversation(conversation);
      }
    },
    propertyTestTimeout(30_000),
  );

  test.each(["approval", "ask-user"] as const)(
    "keeps a failed answer on screen when the next turn waits on %s",
    async (kind) => {
      const conversation = await openConversation();
      const { model, real } = conversation;
      try {
        await new SendUserMessage(["fail"], "Draft the NDA").run(model, real);
        // The fixture must reach the fault: the next turn ends at a card,
        // whose snapshot rebuilds the page's messages.
        await new SendUserMessage(
          [[{ ...STEP, calls: [kind] }]],
          "Draft the NDA",
        ).run(model, real);
        expect(real.ledger.pending).toHaveLength(1);
      } finally {
        closeConversation(conversation);
      }
    },
    propertyTestTimeout(30_000),
  );

  test.each(["after-tool-end", "before-tool-end"] as const)(
    "ends a stopped turn on the page with one Stop (%s)",
    async (quietAt) => {
      const conversation = await openConversation();
      const { real } = conversation;
      try {
        real.harness.streamLive(real.threadId);
        real.harness.script(real.threadId, [
          {
            quietUntilAborted: quietAt,
            text: "Checking the register",
            toolCalls: [
              {
                arguments: PLAIN_TOOL_ARGUMENTS,
                toolCallId: "call-1",
                toolName: PLAIN_TOOL_NAME,
              },
            ],
            type: "step",
          },
        ]);
        await real.client.startUserMessage(
          Bun.randomUUIDv7(),
          "Check the register",
          (messages) =>
            messages.some(({ parts }) =>
              parts.some(({ type }) => type === "tool-call"),
            ),
        );
        await real.client.stop();
        const web = await loadWebChat();
        const messages = real.client.messages();
        expect(
          web.isChatTurnGenerating({
            hasError: false,
            messages,
            requestActive: real.client.runtimeState().requestActive,
            sessionGenerating: false,
          }),
        ).toBe(false);
      } finally {
        closeConversation(conversation);
      }
    },
    propertyTestTimeout(30_000),
  );

  test(
    "bounds every model call of a turn by the model's catalog output limit",
    async () => {
      const conversation = await openConversation();
      const { model, real } = conversation;
      try {
        await new SendUserMessage(
          [
            [
              { ...STEP, calls: ["plain"] },
              { ...STEP, text: true },
            ],
          ],
          "Draft the NDA",
        ).run(model, real);
        const calls = real.harness.modelOptionsOf(real.threadId);
        // The fixture must reach the fault: a turn of two model calls.
        expect(calls).toHaveLength(2);
        // The harness's chat model is OpenAI's, which reads the allowance
        // from `max_output_tokens`.
        expect(
          calls.map((options) =>
            typeof options === "object" && options !== null
              ? Reflect.get(options, "max_output_tokens")
              : undefined,
          ),
        ).toEqual([
          getOutputTokenLimit(HARNESS_CHAT_MODEL_ID),
          getOutputTokenLimit(HARNESS_CHAT_MODEL_ID),
        ]);
      } finally {
        closeConversation(conversation);
      }
    },
    propertyTestTimeout(30_000),
  );

  test(
    "keeps a run's server call and the approval it then asks for",
    async () => {
      const conversation = await openConversation();
      const { model, real } = conversation;
      try {
        await new SendUserMessage(
          [
            [
              { ...STEP, calls: ["plain"] },
              { ...STEP, calls: ["approval"] },
            ],
          ],
          "Draft the NDA",
        ).run(model, real);
        // The fixture must reach the fault: two model steps in one run, the
        // second one tool calls only, ending at an interrupt.
        expect(real.ledger.calls.map(({ kind }) => kind)).toEqual([
          "plain",
          "approval",
        ]);
        await new ReloadPage().run(model, real);
      } finally {
        closeConversation(conversation);
      }
    },
    propertyTestTimeout(30_000),
  );

  test(
    "runs a server call at once when its model step also asks for an approval",
    async () => {
      const conversation = await openConversation();
      const { model, real } = conversation;
      try {
        await new SendUserMessage(
          [[{ ...STEP, calls: ["plain", "approval"] }]],
          "Draft the NDA",
        ).run(model, real);
        // The fixture must reach the fault: one model step holds a server
        // call and a call that waits on the user.
        expect(real.ledger.pending).toHaveLength(1);
        await new ReloadPage().run(model, real);

        await new ResolveCards(
          ["approve", "approve", "approve", "approve"],
          [[{ ...STEP, text: true }]],
        ).run(model, real);
        await new ReloadPage().run(model, real);
      } finally {
        closeConversation(conversation);
      }
    },
    propertyTestTimeout(30_000),
  );

  test(
    "accepts an approval whose model arguments spell absent fields as null",
    async () => {
      // Strict tool schemas make every optional field required and nullable,
      // so the provider sends `null` for one the model leaves out.
      const { real } = await openConversation();
      const { harness, threadId } = real;
      try {
        harness.script(threadId, [
          {
            toolCalls: [
              {
                arguments: JSON.stringify({ name: "NDA", note: null }),
                input: { name: "NDA" },
                toolCallId: "call-strict",
                toolName: APPROVAL_TOOL_NAME,
              },
            ],
            type: "step",
          },
        ]);
        await real.client.sendUserMessage(Bun.randomUUIDv7(), "Delete the NDA");
        await harness.expectSoundWebClient({ client: real.client, threadId });

        harness.script(threadId, [
          { toolCalls: [], text: "Deleted.", type: "step" },
        ]);
        await real.client.approve("call-strict", true);
        await harness.expectSoundWebClient({ client: real.client, threadId });
        expect(harness.executions).toEqual(["NDA"]);
      } finally {
        closeConversation({ real });
      }
    },
    propertyTestTimeout(30_000),
  );

  test(
    "keeps an approved call's result when the model fails before answering",
    async () => {
      const conversation = await openConversation();
      const { model, real } = conversation;
      try {
        await new SendUserMessage(
          [[{ ...STEP, calls: ["approval"], text: true }]],
          "Draft the NDA",
        ).run(model, real);
        expect(real.ledger.pending).toHaveLength(1);

        await new ResolveCards(["approve"], ["fail"]).run(model, real);
        // The fixture must reach the fault: the tool ran and the turn failed.
        expect({
          executed: real.harness.executions,
          latest: real.ledger.latest,
        }).toEqual({ executed: real.ledger.effects, latest: "failed" });

        await new ReloadPage().run(model, real);
      } finally {
        closeConversation(conversation);
      }
    },
    propertyTestTimeout(30_000),
  );

  test(
    "runs an approved call once when the process serving it dies",
    async () => {
      const { real } = await openConversation();
      const { harness, threadId } = real;
      try {
        harness.script(threadId, [
          {
            type: "step",
            toolCalls: [
              {
                arguments: approvalToolArguments("NDA"),
                toolCallId: "call-nda",
                toolName: APPROVAL_TOOL_NAME,
              },
            ],
          },
        ]);
        await real.client.sendUserMessage(Bun.randomUUIDv7(), "Delete the NDA");
        harness.script(threadId, [{ type: "stall" }]);
        harness.crashDuringNextRequest(threadId);
        await real.client.approve("call-nda", true);
        real.client.dispose();
        // The fixture must reach the fault: the call ran before the process
        // died, so no result was stored.
        expect(harness.executions).toEqual(["NDA"]);

        real.client = await harness.openWebClient(threadId);
        harness.script(threadId, [
          { toolCalls: [], text: "Anything else?", type: "step" },
        ]);
        await real.client.sendUserMessage(Bun.randomUUIDv7(), "Thanks");
        // This page loaded before the next turn settled the dead one, so only
        // a fresh load shows the settled call.
        real.client.dispose();
        real.client = await harness.openWebClient(threadId);
        await harness.expectSoundWebClient({ client: real.client, threadId });

        expect(harness.executions).toEqual(["NDA"]);
      } finally {
        closeConversation({ real });
      }
    },
    propertyTestTimeout(30_000),
  );

  test(
    "asks again for an approval whose call id an interrupted turn used",
    async () => {
      // Some providers number tool calls per response, so a later turn can
      // reuse an earlier turn's call id.
      const reusedId = "call_0";
      const deleteCall = (name: string) => ({
        type: "step" as const,
        toolCalls: [
          {
            arguments: approvalToolArguments(name),
            toolCallId: reusedId,
            toolName: APPROVAL_TOOL_NAME,
          },
        ],
      });
      const { real } = await openConversation();
      const { harness, threadId } = real;
      try {
        harness.script(threadId, [deleteCall("first")]);
        await real.client.sendUserMessage(Bun.randomUUIDv7(), "Delete one");
        harness.script(threadId, [{ type: "stall" }]);
        harness.crashDuringNextRequest(threadId);
        await real.client.approve(reusedId, true);
        real.client.dispose();
        // The fixture must reach the fault: the first call ran before the
        // process died.
        expect(harness.executions).toEqual(["first"]);

        real.client = await harness.openWebClient(threadId);
        harness.script(threadId, [deleteCall("second")]);
        await real.client.sendUserMessage(Bun.randomUUIDv7(), "Delete another");

        expect({
          card: real.client
            .cards()
            .some(
              ({ kind, toolCallId }) =>
                kind === "approval" && toolCallId === reusedId,
            ),
          secondRan: harness.executions.includes("second"),
        }).toEqual({ card: true, secondRan: false });
      } finally {
        closeConversation({ real });
      }
    },
    propertyTestTimeout(30_000),
  );

  // PR CI runs the seeded budget; the nightly sweep
  // (`PROPERTY_TEST_NUM_RUNS_FACTOR`) runs it ten times over with fresh seeds.
  test(
    "matches a reload and the ledger after every step of any conversation",
    async () => {
      await runConversations(
        fc.commands(conversationCommands, { maxCommands: 6 }),
      );
    },
    propertyTestTimeout(240_000),
  );

  test.each([
    ["an approval", ["approval"]],
    ["an ask-user card", ["ask-user"]],
  ] satisfies [string, CallKind[]][])(
    "regenerates the latest answer while %s waits",
    async (_label, calls) => {
      const conversation = await openConversation();
      const { model, real } = conversation;
      try {
        await new SendUserMessage([[{ ...STEP, calls }]], "Draft the NDA").run(
          model,
          real,
        );
        // The fixture must reach the fault: the answer still waits.
        expect(real.ledger.pending).toHaveLength(calls.length);
        await new ResendLatest([TEXT_ANSWER]).run(model, real);
        await new ReloadPage().run(model, real);
      } finally {
        closeConversation(conversation);
      }
    },
    propertyTestTimeout(30_000),
  );

  test(
    "forks an answer and continues there",
    async () => {
      const conversation = await openConversation();
      const { model, real } = conversation;
      try {
        await new SendUserMessage(
          [[{ ...STEP, calls: ["approval"] }]],
          "Delete the NDA",
        ).run(model, real);
        await new ResolveCards(["approve"], [TEXT_ANSWER]).run(model, real);
        await new SendUserMessage([TEXT_ANSWER], "Anything else?").run(
          model,
          real,
        );
        await new ForkFrom(0).run(model, real);
        // The fixture must reach the fault: the fork holds the first turn
        // and its approved call only.
        expect(real.ledger.calls).toHaveLength(1);
        await new SendUserMessage([TEXT_ANSWER], "Continue").run(model, real);
        expect(real.harness.executions).toHaveLength(1);
      } finally {
        closeConversation(conversation);
      }
    },
    propertyTestTimeout(30_000),
  );

  test.failing(
    "sends a message typed while an approval waits",
    sendPastAnApproval,
    propertyTestTimeout(30_000),
  );

  test.failing.each([
    ["an approval", ["approval"]],
    ["an ask-user card", ["ask-user"]],
    ["a mixed batch", ["approval", "ask-user", "approval"]],
  ] satisfies [string, CallKind[]][])(
    "lets a new message replace %s that still waits",
    async (_label, calls) => {
      await replaceWaiting(calls);
    },
    propertyTestTimeout(30_000),
  );

  test.failing(
    "resumes the new turn's own calls after a message replaced waiting ones",
    resumeAfterReplacing,
    propertyTestTimeout(30_000),
  );

  test.failing.each(["after-tool-end", "before-tool-end"] as const)(
    "stops an answer while it streams (%s)",
    async (quietAt) => {
      await stopWhileStreaming(quietAt);
    },
    propertyTestTimeout(30_000),
  );

  test.failing(
    "continues a fork taken while a question waits",
    forkWhileAQuestionWaits,
    propertyTestTimeout(30_000),
  );

  test.failing(
    "stops a client call the page still runs",
    stopARunningClientCall,
    propertyTestTimeout(30_000),
  );

  test.each(Object.keys(OPEN_GAPS))(
    "open finding %s still fails its case",
    async (id) => {
      const gap = Object.entries(OPEN_GAPS).find(([key]) => key === id)?.[1];
      const outcome = await (gap ?? expect.unreachable(`No open finding ${id}`))
        .reproduce()
        .then(
          () => "passes",
          () => "fails",
        );
      if (outcome === "passes") {
        panic(`${id} passes now: remove it from OPEN_GAPS`);
      }
    },
    propertyTestTimeout(30_000),
  );

  test("the open findings only shrink, and each names its condition", () => {
    expect(Object.keys(OPEN_GAPS)).toHaveLength(OPEN_GAPS_SIZE);
    expect(
      Object.entries(OPEN_GAPS)
        .filter(([, { condition }]) => condition.trim() === "")
        .map(([id]) => id),
    ).toEqual([]);
  });

  test("maps every action the page offers to the model's commands", async () => {
    const web = await loadWebChat();
    expect(Object.keys(ACTION_COVERAGE).toSorted()).toEqual(
      web.chatUserActions.toSorted(),
    );
  });

  test(
    "matches a reload and the ledger after every action the page offers",
    async () => {
      await runConversations(
        fc.commands(
          pageActionCommandsOf(runsOf(mixedCallsArb)).map((arbitrary) =>
            arbitrary.map((command) => new OutsideOpenGaps(command)),
          ),
          { maxCommands: 6 },
        ),
      );
    },
    propertyTestTimeout(240_000),
  );

  test.failing(
    "matches a reload and the ledger when a new message replaces waiting cards",
    async () => {
      await runConversations(
        fc.commands([...conversationCommands, supersedeCommand], {
          maxCommands: 6,
        }),
      );
    },
    propertyTestTimeout(240_000),
  );
});
