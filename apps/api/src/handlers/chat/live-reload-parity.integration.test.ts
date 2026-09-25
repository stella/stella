import type { UIMessage } from "@tanstack/ai-client";
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
import { ASK_USER_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
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

type CallKind = "approval" | "ask-user" | "plain";
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
  latest: "awaiting" | "failed" | "none" | "text";
  pending: string[];
  turn: number;
};

const newLedger = (): Ledger => ({
  calls: [],
  effects: [],
  failures: 0,
  approvesAll: false,
  latest: "none",
  pending: [],
  turn: 0,
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
};

/** After `approve-all`, approves the approval cards on screen, one click
 *  each, round after round. */
const approveCardsOnScreen = async (real: Real) => {
  for (let round = 0; round < 10; round += 1) {
    const cards = real.client.cards();
    if (
      !real.ledger.approvesAll ||
      cards.length === 0 ||
      !cards.every((card) => card.kind === "approval")
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
  const live = toolCallIdsOf(real.client.messages());
  const reloaded = toolCallIdsOf(reload);
  const pendingMatches =
    JSON.stringify(onScreen) === JSON.stringify(ledger.pending) &&
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
  model.latest = ledger.latest;
  model.pendingKinds = ledger.pending.map((id) => kindOf(ledger, id));
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
  readonly runs: readonly RunShape[];
  readonly text: string;
  constructor(runs: readonly RunShape[], text: string) {
    this.runs = runs;
    this.text = text;
  }
  check = (model: Readonly<Model>) => model.pendingKinds.length === 0;
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

/** Records the user's answers to the open cards in the ledger. */
const decideBatch = (ledger: Ledger, decisions: readonly Decision[]) =>
  ledger.pending.map((id, index) => {
    if (kindOf(ledger, id) === "ask-user") {
      return { decision: "answer" as const, id };
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
    await (decision === "answer"
      ? page.answer(id, ASK_USER_ANSWER)
      : page.approve(id, decision !== "deny"));
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
  readonly continuations: readonly RunShape[];
  readonly decisions: readonly Decision[];
  constructor(
    decisions: readonly Decision[],
    continuations: readonly RunShape[],
  ) {
    this.continuations = continuations;
    this.decisions = decisions;
  }
  check = (model: Readonly<Model>) => model.pendingKinds.length > 0;
  run = async (model: Model, real: Real) => {
    const failuresBefore = real.ledger.failures;
    await resolveOnFirstTab(real, this.decisions, this.continuations);
    await verify(model, real, { failuresBefore });
  };
  toString = () =>
    `ResolveCards(${JSON.stringify(this.decisions)}, ${JSON.stringify(this.continuations)})`;
}

class ReloadPage implements fc.AsyncCommand<Model, Real> {
  check = () => true;
  run = async (model: Model, real: Real) => {
    real.client.dispose();
    real.client = await real.harness.openWebClient(real.threadId);
    await verify(model, real, { failuresBefore: real.ledger.failures });
  };
  toString = () => "ReloadPage";
}

class ResendLatest implements fc.AsyncCommand<Model, Real> {
  readonly runs: readonly RunShape[];
  constructor(runs: readonly RunShape[]) {
    this.runs = runs;
  }
  check = (model: Readonly<Model>) =>
    model.pendingKinds.length === 0 &&
    (model.latest === "text" || model.latest === "failed");
  run = async (model: Model, real: Real) => {
    const { ledger } = real;
    const failuresBefore = ledger.failures;
    // The regenerated answer replaces the latest turn's message; what that
    // message's approved calls did stays done.
    ledger.calls = ledger.calls.filter(({ turn }) => turn !== ledger.turn);
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
    model.pendingKinds.length > 0 &&
    model.pendingKinds.every((kind) => kind === "approval");
  run = async (model: Model, real: Real) => {
    const failuresBefore = real.ledger.failures;
    const cards = [...real.ledger.pending];
    const stale = await real.harness.openWebClient(real.threadId);
    try {
      await resolveOnFirstTab(real, this.decisions, this.continuations);
      await verify(model, real, { failuresBefore });
      for (const id of cards) {
        await stale.approve(id, this.approved);
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

// --- Generators -----------------------------------------------------------

/** A step's calls: server calls the loop runs at once, or calls that wait on
 *  the user. */
const callsArb = fc.oneof(
  fc.array(fc.constant<CallKind>("plain"), { maxLength: 4 }),
  fc.array(fc.constantFrom<CallKind>("approval", "ask-user"), {
    maxLength: 4,
    minLength: 1,
  }),
);
const stepArb: fc.Arbitrary<StepShape> = fc.record({
  calls: callsArb,
  cutOff: fc.boolean(),
  reasoning: fc.boolean(),
  text: fc.boolean(),
});
const stepsArb: fc.Arbitrary<StepShape[]> = fc.array(stepArb, {
  maxLength: 3,
  minLength: 1,
});
/** A model run: steps, or now and then a provider call that fails before it
 *  answers. */
const runArb: fc.Arbitrary<RunShape> = fc.oneof(
  { arbitrary: stepsArb, weight: 5 },
  { arbitrary: fc.constant<RunShape>("fail"), weight: 1 },
);
/** The runs a step's requests answer with: its own, then the ones
 *  `approve-all` sends. */
const runsArb: fc.Arbitrary<RunShape[]> = fc.array(runArb, {
  maxLength: 3,
  minLength: 1,
});
const decisionsArb = fc.array(
  fc.constantFrom<Decision>("approve", "approve-all", "deny"),
  { maxLength: 4, minLength: 4 },
);

const conversationCommands = [
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
  const model: Model = { latest: "none", pendingKinds: [] };
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
    [
      "a denial",
      "report-error",
      [[{ ...STEP, calls: ["approval"] }]],
      "deny",
    ],
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
});
