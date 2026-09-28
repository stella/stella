import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { CODE_MODE_EXECUTE_TOOL_NAME } from "@/api/handlers/chat/tools/execute/chat-code-mode";
import { ASK_USER_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
import type { ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createApprovalHarness,
  DIRECT_REF_TOOL_NAME,
} from "@/api/tests/helpers/chat-approval-harness";
import type { ChatHarness } from "@/api/tests/helpers/chat-approval-harness";
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

// A document ref the model was shown in a thread resolves on every later
// request of that thread, whichever way it was shown (a direct tool's result
// or a code-mode script's) and whichever request comes next (the answer to a
// question, a new message, a new message after a reload).

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

const ASK_USER_INPUT = {
  analysis: "Two documents found.",
  questions: [{ question: "Which one?", reason: "Only one is needed." }],
};
const ASK_USER_ANSWER = {
  answers: [{ answer: "The first", question: "Which one?" }],
};

/** Lists every document of every matter, by ref. */
const LIST_DOCUMENTS_SCRIPT = `const { matters } = await external_list_matters({});
const found = [];
for (const matter of matters) {
  const { documents } = await external_list_documents({ matter_id: matter.id });
  for (const document of documents) {
    found.push({ id: document.id, name: document.name });
  }
}
return found;`;
/** Reads the document the listing showed as `ent_1`, in a new script. */
const READ_FIRST_DOCUMENT_SCRIPT = `const document = await external_read_document({ entity_id: "ent_1" });
return { id: document.entityId, name: document.name };`;

const codeCall = (toolCallId: string, typescriptCode: string) => ({
  arguments: JSON.stringify({ typescriptCode }),
  toolCallId,
  toolName: CODE_MODE_EXECUTE_TOOL_NAME,
});
const askUserCall = (toolCallId: string) => ({
  arguments: JSON.stringify(ASK_USER_INPUT),
  input: ASK_USER_INPUT,
  toolCallId,
  toolName: ASK_USER_TOOL_NAME,
});
const directCall = (toolCallId: string) => ({
  arguments: "{}",
  toolCallId,
  toolName: DIRECT_REF_TOOL_NAME,
});
const answers = (text: string): ScriptedTurn => ({
  type: "step",
  text,
  toolCalls: [],
});
const asks = (
  calls: Extract<ScriptedTurn, { type: "step" }>["toolCalls"],
  text?: string,
): ScriptedTurn => ({
  type: "step",
  ...(text === undefined ? {} : { text }),
  toolCalls: calls,
});

/** How the model is first shown the document refs. */
const LISTED_BY = {
  /** A code-mode script returns them. */
  code: "code",
  /** A direct server tool's result holds them (behind its approval). */
  direct: "direct",
} as const;
type ListedBy = (typeof LISTED_BY)[keyof typeof LISTED_BY];

/** The request that reads the listed document. */
const READ_IN = {
  /** The continuation after the user answers an ask-user question. */
  answer: "answer",
  /** The user's next message. */
  message: "message",
  /** The user's next message, sent from a reloaded page. */
  reload: "reload",
} as const;
type ReadIn = (typeof READ_IN)[keyof typeof READ_IN];

type Conversation = {
  client: WebChatClient;
  harness: ChatHarness;
  threadId: SafeId<"chatThread">;
};

const settled = async (conversation: Conversation) => {
  await conversation.client.settle();
  await conversation.harness.expectSoundWebClient(conversation);
};

/**
 * Shows the model the listing, and returns the id of the call whose stored
 * result holds it, once the turn is waiting for what `readIn` answers.
 */
const list = async (
  conversation: Conversation,
  listedBy: ListedBy,
  readIn: ReadIn,
): Promise<string> => {
  const { client, harness, threadId } = conversation;
  const endOfListing =
    readIn === READ_IN.answer
      ? asks([askUserCall("call-ask")], "Two documents")
      : answers("Two documents");
  switch (listedBy) {
    case LISTED_BY.code:
      harness.script(threadId, [
        asks([codeCall("call-list", LIST_DOCUMENTS_SCRIPT)]),
        endOfListing,
      ]);
      await client.sendUserMessage(Bun.randomUUIDv7(), "Which documents?");
      await settled(conversation);
      return "call-list";
    case LISTED_BY.direct:
      harness.script(threadId, [asks([directCall("call-list")])]);
      await client.sendUserMessage(Bun.randomUUIDv7(), "Which documents?");
      await settled(conversation);
      harness.script(threadId, [endOfListing]);
      await client.approve("call-list", true);
      await settled(conversation);
      return "call-list";
    default:
      listedBy satisfies never;
      return expect.unreachable(`Unhandled listing: ${String(listedBy)}`);
  }
};

const read = async (conversation: Conversation, readIn: ReadIn) => {
  const { harness, threadId } = conversation;
  harness.script(threadId, [
    asks([codeCall("call-read", READ_FIRST_DOCUMENT_SCRIPT)]),
    answers("Read the first one"),
  ]);
  switch (readIn) {
    case READ_IN.answer:
      await conversation.client.answer("call-ask", ASK_USER_ANSWER);
      break;
    case READ_IN.reload:
      conversation.client.dispose();
      conversation.client = await harness.openWebClient(threadId);
      await conversation.client.sendUserMessage(
        Bun.randomUUIDv7(),
        "Read the first one",
      );
      break;
    case READ_IN.message:
      await conversation.client.sendUserMessage(
        Bun.randomUUIDv7(),
        "Read the first one",
      );
      break;
    default:
      readIn satisfies never;
      return expect.unreachable(`Unhandled read: ${String(readIn)}`);
  }
  await settled(conversation);
};

const storedCall = async (
  harness: ChatHarness,
  threadId: SafeId<"chatThread">,
  callId: string,
) => {
  const call = (await harness.readThreadMessages(threadId))
    .flatMap(({ parts }) => parts)
    .find(
      (part): part is Extract<ChatPart, { type: "tool-call" }> =>
        part.type === "tool-call" && part.id === callId,
    );
  return call ?? expect.unreachable(`No stored call ${callId}`);
};

const CASES = Object.values(LISTED_BY).flatMap((listedBy) =>
  Object.values(READ_IN).map((readIn) => [listedBy, readIn] as const),
);

describe("a ref shown in a thread resolves for the rest of it", () => {
  test.each(CASES)(
    "listed by a %s result, read in the request after the %s",
    async (listedBy, readIn) => {
      const harness = createApprovalHarness({
        ids,
        safeDb,
        scopedDb,
        testDb,
        withDirectRefTool: listedBy === LISTED_BY.direct,
      });
      const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
      seededThreadIds.push(threadId);
      const conversation: Conversation = {
        client: await harness.openWebClient(threadId),
        harness,
        threadId,
      };
      try {
        const listCallId = await list(conversation, listedBy, readIn);
        // The listing showed `ent_1` for entityA2: the fixture reaches the
        // ref the later read names.
        const listed = JSON.stringify(
          (await storedCall(harness, threadId, listCallId)).output,
        );
        expect(listed).toMatch(/"id":"ent_1","name":"entityA2"/u);

        await read(conversation, readIn);

        const readCall = await storedCall(harness, threadId, "call-read");
        expect(readCall.output).toMatchObject({
          result: { id: "ent_1", name: "entityA2" },
          success: true,
        });
        harness.expectStableRefs(threadId);
      } finally {
        conversation.client.dispose();
        harness.close();
      }
    },
  );
});
