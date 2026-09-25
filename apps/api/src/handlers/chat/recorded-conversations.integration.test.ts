import type { UIMessage } from "@tanstack/ai-client";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
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
  PLAIN_TOOL_ARGUMENTS,
  PLAIN_TOOL_NAME,
} from "@/api/tests/helpers/chat-approval-harness";
import type {
  ChatHarness,
  RecordedExchange,
  RecordedPage,
} from "@/api/tests/helpers/chat-approval-harness";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";
import type { WebChatClient } from "@/api/tests/helpers/chat-web-client";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Recorded conversations: for each scenario, the exact requests the web app's
// chat runtime posted, the SSE bodies the real send pipeline answered with,
// and the thread's message page after every request. The web app replays them
// through its rendered chat (`apps/web/src/components/chat/
// recorded-conversations.dom.test.tsx`), so the cards a user sees are checked
// against what this server really sends, never against hand-built streams.
//
// The committed files must equal a fresh recording: this test fails when they
// drift. Regenerate with `bun run gen:chat-transcripts` in apps/api.

const FIXTURE_DIR = path.resolve(
  import.meta.dir,
  "../../../../web/src/components/chat/__fixtures__/recorded-conversations",
);
const WRITE_ENV = "CHAT_TRANSCRIPTS_WRITE";
/** Generated files, which the formatter leaves as written. */
const RECORDING_EXTENSION = ".gen.json";

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

// --- What a recording holds ------------------------------------------------

/** What the user did at one step, as the web replay performs it. */
type RecordedAction =
  | { messageId: string; text: string; type: "send" }
  | {
      decision: "allow-once" | "deny";
      toolCallId: string;
      type: "approve";
    }
  /** The page answers an approval on its own, under a conversation grant. */
  | { toolCallId: string; type: "auto-approve" }
  | { answer: string; toolCallId: string; type: "answer" }
  /** The page posts a client tool's result on its own. */
  | { tool: string; toolCallId: string; type: "client-tool" }
  | { type: "stop" }
  | { type: "drop-connection" };

type RecordedStep = {
  action: RecordedAction;
  /** The requests the step led to, in order. */
  exchanges: RecordedExchange[];
};

type RecordedConversation = {
  initialPage: RecordedPage;
  scenario: string;
  steps: RecordedStep[];
  threadId: string;
};

// --- Stable recordings -----------------------------------------------------

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
/** The run and message ids the web client mints: `run-<epoch ms>-<random>`,
 *  `msg-<epoch ms>-<random>`. */
const CLIENT_ID_PATTERN = /(run|msg)-\d{13}-[0-9a-z]{6}/gu;
const ISO_INSTANT_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu;
/** Epoch milliseconds from 2023 to 2033, the stream's `timestamp` values. */
const EPOCH_MS_PATTERN = /(?<![\d.])1[7-9]\d{11}(?![\d.])/gu;
const RECORDING_EPOCH_MS = Date.UTC(2026, 0, 1);

/** Each distinct match of `pattern`, in order of first appearance, named by
 *  `name(n, match)`: identity is kept, the generated value is not. */
const renameEach = (
  text: string,
  pattern: RegExp,
  name: (index: number, match: string) => string,
): string => {
  const names = new Map<string, string>();
  return text.replaceAll(pattern, (match) => {
    const key = match.toLowerCase();
    const known = names.get(key);
    if (known !== undefined) {
      return known;
    }
    const next = name(names.size + 1, match);
    names.set(key, next);
    return next;
  });
};

/**
 * The recording with every generated value made stable, so a fresh recording
 * of the same conversation is byte for byte the committed one: each distinct
 * UUID and client run id becomes a fixed one in order of first appearance
 * (identity kept), and every instant, ISO or epoch milliseconds, the next of
 * a fixed series a second apart in order of appearance. Whether two instants
 * fell in the same millisecond is timing, not behaviour, so instants keep no
 * identity; the page lists messages oldest first, so theirs stay in order.
 */
const stabilize = (recording: RecordedConversation): string => {
  let instants = 0;
  const nextInstant = () => {
    instants += 1;
    return RECORDING_EPOCH_MS + instants * 1000;
  };
  const text = renameEach(
    renameEach(
      JSON.stringify(recording, null, 2),
      UUID_PATTERN,
      (index) =>
        `00000000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`,
    ),
    CLIENT_ID_PATTERN,
    (index, match) => `${match.slice(0, 3)}-recorded-${String(index)}`,
  )
    .replaceAll(ISO_INSTANT_PATTERN, () =>
      new Date(nextInstant()).toISOString(),
    )
    .replaceAll(EPOCH_MS_PATTERN, () => String(nextInstant()));
  return `${text}\n`;
};

// --- Scenarios ---------------------------------------------------------------

const ASK_USER_INPUT = {
  analysis: "The draft depends on the side the user represents.",
  questions: [{ question: "Which side?", reason: "It decides the draft." }],
};
/** The question as a strict-mode provider sends it: every optional field it
 *  leaves out spelled `null` on the wire, which its adapter drops. */
const ASK_USER_STRICT_ARGUMENTS = JSON.stringify({
  ...ASK_USER_INPUT,
  questions: ASK_USER_INPUT.questions.map((question) => ({
    ...question,
    default: null,
    options: null,
  })),
});
const ASK_USER_QUESTION = "Which side?";
const ASK_USER_ANSWER = "Buyer";
const DRAFT_ARGUMENTS = JSON.stringify({
  name: "Mutual NDA",
  source:
    "@title Mutual NDA\n\nThe parties agree to keep each other's information confidential.",
});

const approvalCall = (toolCallId: string) => ({
  arguments: approvalToolArguments(toolCallId),
  toolCallId,
  toolName: APPROVAL_TOOL_NAME,
});
const plainCall = (toolCallId: string) => ({
  arguments: PLAIN_TOOL_ARGUMENTS,
  toolCallId,
  toolName: PLAIN_TOOL_NAME,
});
const askUserCall = (toolCallId: string) => ({
  arguments: ASK_USER_STRICT_ARGUMENTS,
  input: ASK_USER_INPUT,
  toolCallId,
  toolName: ASK_USER_TOOL_NAME,
});
const draftCall = (toolCallId: string) => ({
  arguments: DRAFT_ARGUMENTS,
  toolCallId,
  toolName: CREATE_DOCUMENT_TOOL_NAME,
});
const answers = (text: string): ScriptedTurn => ({
  type: "step",
  text,
  toolCalls: [],
});
const asks = (
  calls: Extract<ScriptedTurn, { type: "step" }>["toolCalls"],
  text?: string,
  reasoning?: string,
): ScriptedTurn => ({
  type: "step",
  ...(reasoning === undefined ? {} : { reasoning }),
  ...(text === undefined ? {} : { text }),
  toolCalls: calls,
});

type Recorder = {
  client: WebChatClient;
  exchanges: RecordedExchange[];
  harness: ChatHarness;
  steps: RecordedStep[];
  threadId: SafeId<"chatThread">;
};

/**
 * Runs `perform` as one user step and records the requests it started. A
 * step ends once the page is idle, unless `midStream`: the page is still
 * reading its response when the next step begins.
 */
const step = async (
  recorder: Recorder,
  action: RecordedAction,
  perform: () => Promise<void>,
  { midStream = false }: { midStream?: boolean } = {},
) => {
  const before = recorder.exchanges.length;
  await perform();
  if (!midStream) {
    await recorder.client.settle();
  }
  recorder.steps.push({ action, exchanges: recorder.exchanges.slice(before) });
};

const send = async (
  recorder: Recorder,
  text: string,
  ...runs: (readonly ScriptedTurn[])[]
) => {
  recorder.harness.script(recorder.threadId, ...runs);
  const messageId = Bun.randomUUIDv7();
  await step(recorder, { messageId, text, type: "send" }, async () => {
    await recorder.client.sendUserMessage(messageId, text);
  });
};

const approve = async (
  recorder: Recorder,
  toolCallId: string,
  decision: "allow-once" | "deny",
  ...runs: (readonly ScriptedTurn[])[]
) => {
  recorder.harness.script(recorder.threadId, ...runs);
  await step(
    recorder,
    { decision, toolCallId, type: "approve" },
    async () => await recorder.client.approve(toolCallId, decision !== "deny"),
  );
};

/** The page approves `toolCallId` on its own, under a conversation grant. */
const autoApprove = async (
  recorder: Recorder,
  toolCallId: string,
  ...runs: (readonly ScriptedTurn[])[]
) => {
  recorder.harness.script(recorder.threadId, ...runs);
  await step(
    recorder,
    { toolCallId, type: "auto-approve" },
    async () => await recorder.client.approve(toolCallId, true),
  );
};

/** The web app's own compile of a drafted document, as its result. */
const draftResult = async () => {
  const compiler: unknown = await import(
    new URL(
      "../../../../web/src/components/chat/create-document-compiler.ts",
      import.meta.url,
    ).href
  );
  const draft: unknown = await import(
    new URL(
      "../../../../web/src/components/chat/create-document-draft.logic.ts",
      import.meta.url,
    ).href
  );
  const { name, source } = asTestRaw<{ name: string; source: string }>(
    JSON.parse(DRAFT_ARGUMENTS),
  );
  const { compileCreateDocumentSourceToDocument } = asTestRaw<{
    compileCreateDocumentSourceToDocument: (
      source: string,
      options: { titleFallback: string },
    ) =>
      | { fixes: unknown[]; status: "ok"; warnings: unknown[] }
      | { status: "error" };
  }>(compiler);
  const { buildCreateDocumentDownloadFileName } = asTestRaw<{
    buildCreateDocumentDownloadFileName: (name: string) => string;
  }>(draft);
  const compiled = compileCreateDocumentSourceToDocument(source, {
    titleFallback: name,
  });
  if (compiled.status !== "ok") {
    return expect.unreachable("The scripted draft must compile");
  }
  // In the order the web app's draft settlement builds it, which the posted
  // result keeps.
  return {
    success: true,
    destination: "draft",
    fileName: buildCreateDocumentDownloadFileName(name),
    fixes: compiled.fixes,
    warnings: compiled.warnings,
  };
};

/** A tool call that has started streaming in the live view. */
const holdsToolCall = (messages: readonly UIMessage[]) =>
  messages.some(({ parts }) => parts.some(({ type }) => type === "tool-call"));

/** A model call that goes quiet at `quietAt` while its tool call streams. */
const quietTurn = (
  quietAt: "after-tool-end" | "before-tool-end",
): readonly ScriptedTurn[] => [
  {
    type: "step",
    quietUntilAborted: quietAt,
    text: "Checking the register",
    toolCalls: [plainCall("call-1")],
  },
];

const SCENARIOS: Record<string, (recorder: Recorder) => Promise<void>> = {
  "single-approval": async (recorder) => {
    await send(recorder, "Delete the NDA", [asks([approvalCall("call-1")])]);
    await approve(recorder, "call-1", "allow-once", [answers("Deleted")]);
  },
  "approvals-in-one-step": async (recorder) => {
    await send(recorder, "Delete both drafts", [
      asks([approvalCall("call-1"), approvalCall("call-2")]),
    ]);
    await approve(recorder, "call-1", "allow-once");
    await approve(recorder, "call-2", "allow-once", [answers("Both deleted")]);
  },
  // The owning message holds tool results before the approved call, so the
  // engine splits it when it replays the turn.
  "approval-after-tool-result": async (recorder) => {
    await send(recorder, "Tidy the templates", [
      asks([plainCall("call-1")]),
      asks([plainCall("call-2")], undefined, "Two lists to compare"),
      asks([approvalCall("call-3")], "One template is stale"),
    ]);
    await approve(recorder, "call-3", "allow-once", [
      asks([approvalCall("call-4")], "Another one is stale"),
    ]);
    await approve(recorder, "call-4", "allow-once", [answers("Tidied")]);
  },
  "approve-then-another": async (recorder) => {
    await send(recorder, "Delete the NDA", [asks([approvalCall("call-1")])]);
    await approve(recorder, "call-1", "allow-once", [
      asks([approvalCall("call-2")]),
    ]);
    await approve(recorder, "call-2", "allow-once", [answers("Deleted")]);
  },
  "ask-user": async (recorder) => {
    await send(recorder, "Draft the NDA", [asks([askUserCall("call-1")])]);
    recorder.harness.script(recorder.threadId, [answers("Drafted")]);
    await step(
      recorder,
      { answer: ASK_USER_ANSWER, toolCallId: "call-1", type: "answer" },
      async () =>
        await recorder.client.answer("call-1", {
          // In the order the web app's ask-user card builds it.
          answers: [{ question: ASK_USER_QUESTION, answer: ASK_USER_ANSWER }],
        }),
    );
  },
  "client-tool": async (recorder) => {
    await send(recorder, "Draft it as a document", [
      asks([draftCall("call-1")]),
    ]);
    recorder.harness.script(recorder.threadId, [
      answers("The draft is open in the panel"),
    ]);
    const output = await draftResult();
    await step(
      recorder,
      {
        tool: CREATE_DOCUMENT_TOOL_NAME,
        toolCallId: "call-1",
        type: "client-tool",
      },
      async () =>
        await recorder.client.runClientTool(
          "call-1",
          CREATE_DOCUMENT_TOOL_NAME,
          output,
        ),
    );
  },
  // The user has allowed the tool for this conversation, so the page answers
  // each of its approvals as the card appears.
  "conversation-grant": async (recorder) => {
    await send(recorder, "Delete the NDA", [asks([approvalCall("call-1")])]);
    await autoApprove(recorder, "call-1", [
      asks([approvalCall("call-2")], "And the older copy"),
    ]);
    await autoApprove(recorder, "call-2", [answers("Both deleted")]);
  },
  "error-before-first-chunk": async (recorder) => {
    await send(recorder, "Draft the NDA", [
      { message: "Scripted provider failure", type: "fail-before-output" },
    ]);
  },
  "stop-mid-stream": async (recorder) => {
    await sendUntilQuiet(recorder, "after-tool-end");
    await step(recorder, { type: "stop" }, async () => {
      await recorder.client.stop();
    });
  },
  // The process serving the turn dies after a tool call ran, and the next
  // message settles the turn it left behind.
  "interrupted-turn": async (recorder) => {
    recorder.harness.crashDuringNextRequest(recorder.threadId);
    await send(recorder, "List the templates", [
      asks([plainCall("call-1")]),
      { type: "stall" },
    ]);
    // After a failed request the page reloads the thread from the server.
    recorder.client.dispose();
    recorder.client = await recorder.harness.openWebClient(recorder.threadId);
    await send(recorder, "Thanks", [answers("Anything else?")]);
  },
  "connection-drop": async (recorder) => {
    await sendUntilQuiet(recorder, "before-tool-end");
    await step(recorder, { type: "drop-connection" }, async () => {
      recorder.harness.dropConnection(recorder.threadId);
      await Promise.resolve();
    });
  },
};

/** Sends a message whose model call goes quiet while a tool call streams. */
async function sendUntilQuiet(
  recorder: Recorder,
  quietAt: "after-tool-end" | "before-tool-end",
) {
  recorder.harness.streamLive(recorder.threadId);
  recorder.harness.script(recorder.threadId, quietTurn(quietAt));
  const messageId = Bun.randomUUIDv7();
  const text = "Check the register";
  await step(
    recorder,
    { messageId, text, type: "send" },
    async () => {
      await recorder.client.startUserMessage(messageId, text, holdsToolCall);
    },
    { midStream: true },
  );
}

/**
 * Records `scenario`. A step that fails still leaves the steps before it
 * recorded, which is what a mutation run replays in the web app.
 */
const recordScenario = async (
  scenario: string,
  run: (recorder: Recorder) => Promise<void>,
): Promise<{ failure: unknown; recording: RecordedConversation }> => {
  const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  const exchanges = harness.recordThread(threadId);
  const initialPage = await harness.readPage(threadId);
  const client = await harness.openWebClient(threadId);
  const recorder: Recorder = {
    client,
    exchanges,
    harness,
    steps: [],
    threadId,
  };
  let failure: unknown;
  try {
    await run(recorder);
  } catch (error) {
    failure = error;
  } finally {
    recorder.client.dispose();
    harness.close();
  }
  return {
    failure,
    recording: { initialPage, scenario, steps: recorder.steps, threadId },
  };
};

describe("recorded conversations", () => {
  test.each(Object.keys(SCENARIOS))(
    "the committed recording of %s matches the server",
    async (scenario) => {
      const run =
        SCENARIOS[scenario] ?? expect.unreachable(`No scenario ${scenario}`);
      const { failure, recording } = await recordScenario(scenario, run);
      const recorded = stabilize(recording);
      const file = path.join(FIXTURE_DIR, `${scenario}${RECORDING_EXTENSION}`);
      if (process.env[WRITE_ENV] === "1") {
        writeFileSync(file, recorded);
      }
      // A scenario step that failed is the finding, not a stale file.
      expect(failure).toBeUndefined();
      expect(existsSync(file)).toBe(true);
      // Regenerate with `bun run gen:chat-transcripts` in apps/api.
      expect(readFileSync(file, "utf-8")).toBe(recorded);
    },
    60_000,
  );

  test("every committed recording belongs to a scenario", () => {
    expect(
      readdirSync(FIXTURE_DIR)
        .filter((name) => name.endsWith(RECORDING_EXTENSION))
        .toSorted(),
    ).toEqual(
      Object.keys(SCENARIOS)
        .map((scenario) => `${scenario}${RECORDING_EXTENSION}`)
        .toSorted(),
    );
  });
});
