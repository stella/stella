import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import type { TanStackAIProvider } from "@stll/ai-catalog";
import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";
import { propertyTestTimeout } from "@stll/property-testing";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  anonymizationBlacklistEntries,
  chatMessages,
  chatThreads,
  userFiles,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import {
  isProviderVisibleChatPart,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import type { ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { toDataUrl } from "@/api/lib/data-url";
import { isRecord } from "@/api/lib/type-guards";
import { createApprovalHarness } from "@/api/tests/helpers/chat-approval-harness";
import { createPromptPrefixLedger } from "@/api/tests/helpers/chat-prompt-prefix";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  cassetteForModel,
  modelOf,
} from "@/api/tests/helpers/provider-request-matrix";
import {
  cassetteFor,
  loadProviderWireCassettes,
} from "@/api/tests/helpers/provider-wire-cassette";
import {
  wireOrgAIConfig,
  wireSideModel,
} from "@/api/tests/helpers/provider-wire-contract";
import { installProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import type {
  ProviderWireReplay,
  ReplayedRequest,
} from "@/api/tests/helpers/provider-wire-replay";
import { replayedHarnessModel } from "@/api/tests/helpers/replayed-harness-model";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Every kind of stored message part, sent to every provider's real adapter
// under each send mode, from a thread whose history was written under either
// mode. A distinct value is planted in each part; the organization's
// anonymization catalog names every one of them. The adapter's SDK sends its
// request through `fetch`, where the provider wire replay captures the body.
//
// What is guaranteed, per provider, history mode and send mode:
// - Anonymized mode: no request of the turn carries any planted value, in any
//   encoding the body holds (text, JSON, base64 data).
// - Raw mode (the control): the chat request carries the planted value of
//   every part the provider reads, so the fixture reaches the boundary.
// - The part table below is typed over the stored part union: a new part
//   type fails typecheck here until it states how it is sent.

const cassettes = loadProviderWireCassettes();

/** One value per part type, each a name the catalog lists. */
const PLANTED = {
  activity: "Adelina Fairbourne",
  audio: "Aurelio Quintbury",
  document: "Dorotea Framwell",
  image: "Imogen Castlereagh",
  "structured-output": "Seraphin Wolcombe",
  subagent: "Sabeline Ortmoor",
  text: "Tobiah Glenmarrow",
  thinking: "Thaddea Brookhollow",
  "tool-call": "Casimir Vellacourt",
  "tool-result": "Rosalind Harrowbeck",
  "ui-resource": "Ulrika Pennywhistle",
  video: "Valentin Achterberg",
} as const satisfies Record<ChatPart["type"], string>;

const EVERY_PROVIDER = {
  anthropic: true,
  bedrock: true,
  google: true,
  mistral: true,
  openai: true,
  openrouter: true,
} as const satisfies Record<TanStackAIProvider, boolean>;

const NO_PROVIDER = {
  anthropic: false,
  bedrock: false,
  google: false,
  mistral: false,
  openai: false,
  openrouter: false,
} as const satisfies Record<TanStackAIProvider, boolean>;

type StoredPartWire =
  | {
      /** The stored part, carrying its planted value. */
      part: ChatPart;
      /** Which providers read the planted value from the raw request. */
      readBy: Readonly<Record<TanStackAIProvider, boolean>>;
      /** Why a provider does not, when one does not. */
      reason?: string;
    }
  | {
      /** A part the thread never stores, with the table that drops it. */
      notStored: string;
    };

const UI_ONLY = "Its part policy keeps it off the provider (`ui-only`).";

const textFile = (text: string) =>
  toDataUrl(new TextEncoder().encode(text), "text/plain");

/** How each stored part type reaches a provider. */
const STORED_PART_WIRE = {
  activity: {
    notStored:
      "Its persistence policy drops it before storage (`CHAT_PART_PERSISTENCE`).",
  },
  audio: {
    part: {
      type: "audio",
      source: {
        type: "url",
        value: `https://example.test/${encodeURIComponent(PLANTED.audio)}.mp3`,
        mimeType: "audio/mpeg",
      },
    },
    readBy: NO_PROVIDER,
    reason: UI_ONLY,
  },
  document: {
    part: {
      type: "document",
      source: {
        type: "url",
        value: textFile(`Signed by ${PLANTED.document}.`),
        mimeType: "text/plain",
      },
      metadata: { filename: "notes.txt" },
    },
    readBy: EVERY_PROVIDER,
  },
  image: {
    part: {
      type: "image",
      source: {
        type: "url",
        value:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        mimeType: "image/png",
      },
      metadata: { filename: `${PLANTED.image}.png` },
    },
    // An image is sent as its bytes; its file name is not part of what a
    // provider reads. Anonymized mode refuses the turn instead.
    readBy: NO_PROVIDER,
    reason: "Providers read an image's bytes, not its file name.",
  },
  "structured-output": {
    part: {
      type: "structured-output",
      status: "complete",
      raw: JSON.stringify({ signatory: PLANTED["structured-output"] }),
      data: { signatory: PLANTED["structured-output"] },
    },
    readBy: EVERY_PROVIDER,
  },
  subagent: {
    notStored:
      "Its persistence policy drops it before storage (`CHAT_PART_PERSISTENCE`).",
  },
  text: {
    part: { type: "text", content: `Please brief ${PLANTED.text}.` },
    readBy: EVERY_PROVIDER,
  },
  thinking: {
    part: {
      type: "thinking",
      content: `${PLANTED.thinking} signs the lease.`,
    },
    readBy: NO_PROVIDER,
    reason:
      "Adapters replay only reasoning the provider signed; stored reasoning without a signature is not sent.",
  },
  "tool-call": {
    part: {
      type: "tool-call",
      id: "call_stored_1",
      name: "mcp__test__search_documents",
      arguments: JSON.stringify({ query: PLANTED["tool-call"] }),
      input: { query: PLANTED["tool-call"] },
      output: { signedBy: PLANTED["tool-result"] },
      state: "complete",
    },
    readBy: EVERY_PROVIDER,
  },
  "tool-result": {
    part: {
      type: "tool-result",
      toolCallId: "call_stored_1",
      content: JSON.stringify({ signedBy: PLANTED["tool-result"] }),
      state: "complete",
    },
    readBy: EVERY_PROVIDER,
  },
  "ui-resource": {
    part: {
      type: "ui-resource",
      resource: {
        uri: "ui://widget",
        mimeType: "text/html;profile=mcp-app",
        text: `<p>${PLANTED["ui-resource"]}</p>`,
      },
      toolCallId: "call_stored_1",
      toolName: "widget",
    },
    readBy: NO_PROVIDER,
    reason: UI_ONLY,
  },
  video: {
    part: {
      type: "video",
      source: {
        type: "url",
        value: `https://example.test/${encodeURIComponent(PLANTED.video)}.mp4`,
        mimeType: "video/mp4",
      },
    },
    readBy: NO_PROVIDER,
    reason: UI_ONLY,
  },
} satisfies Record<ChatPart["type"], StoredPartWire>;

type StoredPartType = keyof typeof STORED_PART_WIRE;

/**
 * How each stored part gets into the thread. A document is uploaded with the
 * first turn, as the composer sends it; the others are stored after it in
 * one assistant message. An image makes an anonymized turn refuse, so it is
 * stored in a thread of its own.
 */
const HISTORIES = {
  assistant: [
    "text",
    "thinking",
    "tool-call",
    "tool-result",
    "structured-output",
    "audio",
    "video",
    "ui-resource",
  ],
  image: ["image"],
} as const satisfies Record<string, readonly StoredPartType[]>;

/** Every part type the assistant history carries, the upload included. */
const ASSISTANT_HISTORY_TYPES = [
  "document",
  ...HISTORIES.assistant,
] as const satisfies readonly StoredPartType[];

const SEND_MODES = [
  CHAT_SEND_MODE.rawOverride,
  CHAT_SEND_MODE.anonymized,
] as const satisfies readonly ChatSendMode[];

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
let replay: ProviderWireReplay;
let fakeS3: FakeS3;
let previousMockAI: typeof env.USE_MOCK_AI;
let previousBedrockEndpoint: string | undefined;
const seededThreadIds: SafeId<"chatThread">[] = [];
const catalogEntryIds: SafeId<"anonymizationBlacklistEntry">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
  previousMockAI = env.USE_MOCK_AI;
  env.USE_MOCK_AI = false;
  previousBedrockEndpoint = process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
  process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] =
    "https://bedrock-runtime.us-east-1.amazonaws.com.cassette.invalid";
  fakeS3 = startFakeS3();
  replay = installProviderWireReplay({ passThroughOrigins: [fakeS3.endpoint] });
  // The organization's catalog names every planted value, so anonymized
  // mode recognises each one wherever it is stored.
  for (const canonical of Object.values(PLANTED)) {
    const id = toSafeId<"anonymizationBlacklistEntry">(Bun.randomUUIDv7());
    catalogEntryIds.push(id);
    await testDb.insert(anonymizationBlacklistEntries).values({
      canonical,
      id,
      label: "person",
      organizationId: ids.orgA,
    });
  }
});

afterAll(async () => {
  replay.restore();
  fakeS3.stop();
  env.USE_MOCK_AI = previousMockAI;
  if (previousBedrockEndpoint === undefined) {
    delete process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
  } else {
    process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] = previousBedrockEndpoint;
  }
  if (catalogEntryIds.length > 0) {
    await testDb
      .delete(anonymizationBlacklistEntries)
      .where(inArray(anonymizationBlacklistEntries.id, catalogEntryIds));
  }
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(userFiles)
      .where(inArray(userFiles.threadId, seededThreadIds));
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

/** A session on `provider`'s recorded chat model for `threadId`. */
const openSession = async (
  provider: TanStackAIProvider,
  threadId: SafeId<"chatThread">,
) => {
  const endpoint = { provider, slot: "recorded" } as const;
  const model = modelOf(cassettes, endpoint);
  const seam = replayedHarnessModel({
    prompts: createPromptPrefixLedger(),
    provider,
    replay,
  });
  const harness = createApprovalHarness({
    ids,
    model: seam,
    organizationAIConfig: wireOrgAIConfig({
      apiKey: "cassette-replay-no-credentials",
      chatModel: model,
      provider,
      sideModel: wireSideModel(provider, model),
    }),
    safeDb,
    scopedDb,
    testDb,
  });
  const client = await harness.openWebClient(threadId);
  const answer = cassetteForModel(
    cassetteFor(cassettes, provider, "text"),
    model,
  );
  replay.answerSideCalls(answer.exchanges[0]);
  return {
    answer,
    client,
    close: async () => {
      client.dispose();
      await harness.close();
      replay.answerSideCalls(undefined);
    },
    seam,
  };
};

type Turn = {
  /** Whether the page shows the turn failed. */
  failed: boolean;
  /** Every request the turn sent, side calls included. */
  sent: readonly ReplayedRequest[];
};

/**
 * A thread whose first turn went out under `historyMode`, with the parts of
 * `history` stored after it, continued by a turn under `sendMode`.
 */
const converse = async ({
  history,
  historyMode,
  provider,
  sendMode,
}: {
  history: keyof typeof HISTORIES;
  historyMode: ChatSendMode;
  provider: TanStackAIProvider;
  sendMode: ChatSendMode;
}): Promise<Turn> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  replay.forgetSignedCalls();

  const first = await openSession(provider, threadId);
  try {
    replay.serve(first.answer);
    await first.client.sendUserContent(
      Bun.randomUUIDv7(),
      history === "image"
        ? [{ type: "text", content: "Hello" }]
        : [{ type: "text", content: "Hello" }, STORED_PART_WIRE.document.part],
      { sendMode: historyMode },
    );
    if (first.client.runtimeState().hasError) {
      panic("The history's first turn failed");
    }
  } finally {
    await first.close();
  }

  const parts = HISTORIES[history].map((type) => {
    const entry: StoredPartWire = STORED_PART_WIRE[type];
    return "part" in entry ? entry.part : panic(`${type} is never stored`);
  });
  await testDb.insert(chatMessages).values({
    content: toPersistedChatMessageContentV3({ data: parts }),
    id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
    role: history === "image" ? "user" : "assistant",
    threadId,
    userId: ids.userA1,
    workspaceId: null,
  });

  const second = await openSession(provider, threadId);
  try {
    replay.serve(second.answer);
    // The replay's log spans the whole file; this turn's requests are the
    // ones after it starts.
    const earlier = second.seam.sentRequests().length;
    await second.client.sendUserMessage(Bun.randomUUIDv7(), "Thanks", {
      sendMode,
    });
    return {
      failed: second.client.runtimeState().hasError,
      sent: second.seam.sentRequests().slice(earlier),
    };
  } finally {
    await second.close();
  }
};

const BASE64_RUN = /^[A-Za-z0-9+/]{16,}={0,2}$/u;
const DATA_URL = /^data:[^;,]+;base64,(?<payload>.+)$/u;

/**
 * Every string a request body carries, and the text of every base64 value
 * in it, so a value an adapter encodes (a file's bytes) is read as well.
 */
const readableTextOf = (request: ReplayedRequest): string => {
  const texts: string[] = [request.body];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      const payload = DATA_URL.exec(value)?.groups?.["payload"] ?? value;
      if (BASE64_RUN.test(payload)) {
        texts.push(Buffer.from(payload, "base64").toString("utf-8"));
      }
      return;
    }
    if (Array.isArray(value) || isRecord(value)) {
      for (const child of Object.values(value)) {
        visit(child);
      }
    }
  };
  const parsed: unknown = JSON.parse(request.body);
  visit(parsed);
  return texts.join("\n");
};

/** The requests the chat model answered, rather than side calls. */
const chatRequestsOf = (sent: readonly ReplayedRequest[]) =>
  sent.filter(({ exchange }) => typeof exchange === "number");

/** CONVERSATION_TIMEOUT_MS: two turns of a few seconds each. */
const CONVERSATION_TIMEOUT_MS = 60_000;

describe("every stored part is prepared for the send mode", () => {
  test("every part type states how it reaches a provider", () => {
    // A UI-only part is read by no provider, and a part some provider does
    // not read says why.
    for (const [type, entry] of Object.entries(STORED_PART_WIRE)) {
      if (!("part" in entry)) {
        continue;
      }
      if (!isProviderVisibleChatPart(entry.part)) {
        expect({ type, readBy: entry.readBy }).toEqual({
          type,
          readBy: NO_PROVIDER,
        });
      }
      if (!Object.values(entry.readBy).every(Boolean)) {
        expect({
          type,
          reason: "reason" in entry && entry.reason !== "",
        }).toEqual({
          type,
          reason: true,
        });
      }
    }
  });

  for (const provider of TANSTACK_AI_PROVIDERS) {
    for (const historyMode of SEND_MODES) {
      for (const sendMode of SEND_MODES) {
        test(
          `${provider}: history written ${historyMode}, sent ${sendMode}`,
          async () => {
            const turn = await converse({
              history: "assistant",
              historyMode,
              provider,
              sendMode,
            });
            expect(turn.failed).toBe(false);
            const chatRequests = chatRequestsOf(turn.sent);
            expect(chatRequests.length).toBeGreaterThan(0);

            for (const type of ASSISTANT_HISTORY_TYPES) {
              const entry = STORED_PART_WIRE[type];
              const planted = PLANTED[type];
              if (sendMode === CHAT_SEND_MODE.anonymized) {
                // No request of the turn carries it.
                expect({
                  type,
                  sent: turn.sent.some((request) =>
                    readableTextOf(request).includes(planted),
                  ),
                }).toEqual({ type, sent: false });
              } else {
                // The control: the fixture reaches the provider.
                expect({
                  type,
                  sent: chatRequests.some((request) =>
                    readableTextOf(request).includes(planted),
                  ),
                }).toEqual({ type, sent: entry.readBy[provider] });
              }
            }
          },
          propertyTestTimeout(CONVERSATION_TIMEOUT_MS),
        );
      }
    }

    for (const sendMode of SEND_MODES) {
      test(
        `${provider}: a stored image, sent ${sendMode}`,
        async () => {
          const turn = await converse({
            history: "image",
            historyMode: CHAT_SEND_MODE.rawOverride,
            provider,
            sendMode,
          });
          expect(
            turn.sent.some((request) =>
              readableTextOf(request).includes(PLANTED.image),
            ),
          ).toBe(false);
          if (sendMode === CHAT_SEND_MODE.anonymized) {
            // Only plain-text files can be prepared; the turn is refused
            // before any request.
            expect(turn.failed).toBe(true);
            expect(chatRequestsOf(turn.sent)).toEqual([]);
          }
        },
        propertyTestTimeout(CONVERSATION_TIMEOUT_MS),
      );
    }
  }
});
