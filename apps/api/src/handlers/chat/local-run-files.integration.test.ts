import { EventType } from "@tanstack/ai";
import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import { harnessEventsToChunks } from "@stll/agent-engine";
import type { HarnessEvent } from "@stll/agent-engine";
import {
  DESKTOP_RUNNER_DESKTOP_MESSAGE,
  DESKTOP_RUNNER_OUTPUT_EVENT,
} from "@stll/api-contract/desktop-runner";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads, userFiles } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  createLocalChatRun,
  LOCAL_RUN_OUTPUTS_INSTRUCTIONS,
  type LocalChatRun,
  type LocalRunContext,
} from "@/api/handlers/chat/local-run-chunks";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { createLocalRunBell } from "@/api/lib/desktop-runner/doorbell";
import { readRunOutputFile } from "@/api/lib/desktop-runner/store";
import { createUserFileKey } from "@/api/lib/file-key";
import { toUserFileUrl } from "@/api/lib/user-files/types";
import { createApprovalHarness } from "@/api/tests/helpers/chat-approval-harness";
import { installScriptedProvider } from "@/api/tests/helpers/chat-scripted-provider";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * A turn on the member's computer that hands a file back, through the real
 * send, stream pipeline, store and web client. The computer's messages are
 * what its sidecar stores; everything after them is production code.
 */

// timeout: each test drives whole turns through the send, the store and the web client.
setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let scopedDb: ScopedDb;
let safeDb: SafeDb;
let fake: FakeS3;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  fake = startFakeS3();
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
    // A thread's files hold it back: its delete path removes them first.
    await testDb
      .delete(userFiles)
      .where(inArray(userFiles.threadId, seededThreadIds));
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  fake.stop();
  await releaseRlsFixture();
});

type RunReport =
  | { status: "uploaded"; fileId: string; fileName: string }
  | { status: "failed"; fileName: string };

const textTurn = (text: string): HarnessEvent[] => [
  ...(text === ""
    ? []
    : [{ type: "text.completed", messageId: "msg_1", text } as const]),
  { type: "turn.completed", usage: null },
];

const asStored = async (
  runId: string,
  reports: readonly RunReport[],
  text: string,
) => {
  const chunks: unknown[] = [];
  const source = (async function* () {
    yield* textTurn(text);
  })();
  let generated = 0;
  for await (const chunk of harnessEventsToChunks(source, {
    harness: "codex",
    model: "gpt-test",
    runId,
    threadId: "desktop-thread",
    generateId: () => {
      generated += 1;
      return `generated-${String(generated)}`;
    },
    now: () => 0,
  })) {
    chunks.push(chunk);
  }
  // The sidecar reports its files right before the finish that ends the turn.
  const finishAt = chunks.length - 1;
  return [
    ...chunks.slice(0, finishAt),
    ...reports.map((value) => ({
      type: EventType.CUSTOM,
      name: DESKTOP_RUNNER_OUTPUT_EVENT,
      value,
    })),
    ...chunks.slice(finishAt),
  ];
};

/** A run that already finished on the computer, as the gateway stored it. */
const localRunFor = ({
  threadId,
  reports,
  text,
  onStart,
}: {
  threadId: SafeId<"chatThread">;
  reports: () => readonly RunReport[];
  text: string;
  onStart: (instructions: string) => void;
}): LocalChatRun => {
  const runId = Bun.randomUUIDv7();
  const control: LocalRunContext["control"] = asTestRaw({
    readChatRunSession: async () => await Promise.resolve(Result.ok(null)),
    startRun: async ({ instructions }: { instructions: string }) => {
      onStart(instructions);
      return await Promise.resolve(Result.ok({ type: "assigned", runId }));
    },
    readEvents: async ({ afterSeq }: { afterSeq: number }) => {
      if (afterSeq > 0) {
        return Result.ok({ items: [], nextAfterSeq: null });
      }
      const chunks = await asStored(runId, reports(), text);
      const items = [
        ...chunks.map((chunk, index) => ({
          seq: index + 1,
          message: {
            type: DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent,
            runId,
            seq: index + 1,
            chunk,
          },
        })),
        {
          seq: chunks.length + 1,
          message: {
            type: DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished,
            runId,
            seq: chunks.length + 1,
            outcome: "completed",
            harnessSessionId: null,
          },
        },
      ];
      return Result.ok({ items, nextAfterSeq: null });
    },
    readRun: async () =>
      await Promise.resolve(Result.ok({ runId, state: "finished" })),
    readRunOutputFile: async (
      options: Parameters<typeof readRunOutputFile>[1],
    ) => Result.ok(await readRunOutputFile(testDb, options)),
    recordChatReadSeq: async () => await Promise.resolve(Result.ok(undefined)),
    interruptRun: async () =>
      await Promise.resolve(Result.ok({ type: "queued" })),
  });
  return createLocalChatRun(
    {
      control,
      runBell: createLocalRunBell(),
      owner: { organizationId: ids.orgA, userId: ids.userA1 },
      chatThreadId: threadId,
      workspaceIds: [],
      mcp: { serverName: "stella", url: "https://api.example.test/mcp" },
      pollMs: 10,
    },
    {
      type: "start",
      destination: {
        desktopId: Bun.randomUUIDv7(),
        harness: "codex",
        harnessVersion: "1.0.0",
        model: "gpt-test",
        approvals: "ask",
      },
    },
  );
};

const storeFile = async ({
  threadId,
  fileName,
  mimeType,
  placeholder = null,
}: {
  threadId: SafeId<"chatThread">;
  fileName: string;
  mimeType: string;
  placeholder?: string | null;
}) => {
  const id = createSafeId<"userFile">();
  await testDb.insert(userFiles).values({
    id,
    userId: ids.userA1,
    fileName,
    mimeType,
    sizeBytes: 10,
    sha256Hex: "a".repeat(64),
    s3Key: createUserFileKey({
      fileId: id,
      mimeType,
      organizationId: ids.orgA,
    }),
    threadId,
    placeholder,
  });
  return id;
};

/** A thread whose next turn runs on the computer unless a test says otherwise. */
const openThread = async () => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  const local: { run: LocalChatRun | undefined } = { run: undefined };
  const model = installScriptedProvider();
  const harness = createApprovalHarness({
    ids,
    localRunOf: () => local.run,
    model,
    safeDb,
    scopedDb,
    testDb,
  });
  const client = await harness.openWebClient(threadId);
  return { client, harness, local, model, threadId };
};

type Part = { type: string; source?: unknown; metadata?: unknown };

const lastAnswerParts = (
  messages: readonly { role: string; parts: readonly unknown[] }[],
) =>
  asTestRaw<Part[]>(
    messages.findLast(({ role }) => role === "assistant")?.parts ?? [],
  );

const fileParts = (parts: readonly Part[]) =>
  parts.filter(({ type }) => type === "document" || type === "image");

describe("a file a turn on the computer hands back", () => {
  test("reads the same live and after a reload, with the turn's text", async () => {
    const { client, harness, local, threadId } = await openThread();
    try {
      const reports: RunReport[] = [];
      const instructions: string[] = [];
      local.run = localRunFor({
        threadId,
        text: "The report is ready.",
        onStart: (sent) => instructions.push(sent),
        reports: () => reports,
      });
      // The chat thread exists from the first send, so the file is stored
      // when the run reports it, as the upload does before its report.
      const before = local.run.stream.bind(local.run);
      local.run = {
        ...local.run,
        stream: (input) =>
          (async function* () {
            const pdf = await storeFile({
              threadId,
              fileName: "report.pdf",
              mimeType: "application/pdf",
            });
            const chart = await storeFile({
              threadId,
              fileName: "chart.png",
              mimeType: "image/png",
              placeholder: "data:image/png;base64,AAAA",
            });
            reports.push(
              { status: "uploaded", fileId: pdf, fileName: "report.pdf" },
              { status: "uploaded", fileId: chart, fileName: "chart.png" },
            );
            yield* before(input);
          })(),
      };

      await client.sendUserMessage(Bun.randomUUIDv7(), "Write the report");
      await client.settle();
      expect(client.runtimeState().hasError).toBe(false);
      expect(instructions.at(0)).toContain(LOCAL_RUN_OUTPUTS_INSTRUCTIONS);

      const live = lastAnswerParts(client.messages());
      expect(fileParts(live).map(({ type }) => type)).toEqual([
        "document",
        "image",
      ]);
      const reload = lastAnswerParts(await harness.reloadView(threadId));
      expect(fileParts(reload)).toEqual(fileParts(live));
      expect(live.map(({ type }) => type)).toEqual(
        reload.map(({ type }) => type),
      );
      expect(reload.at(0)).toMatchObject({
        type: "text",
        content: "The report is ready.",
      });
      expect(fileParts(reload).at(1)).toMatchObject({
        metadata: {
          filename: "chart.png",
          placeholder: "data:image/png;base64,AAAA",
        },
        source: { type: "url", mimeType: "image/png" },
      });
    } finally {
      client.dispose();
      await harness.close();
    }
  });

  test("a turn that says nothing but hands a file back still answers", async () => {
    const { client, harness, local, threadId } = await openThread();
    try {
      const reports: RunReport[] = [];
      const run = localRunFor({
        threadId,
        text: "",
        onStart: () => undefined,
        reports: () => reports,
      });
      local.run = {
        ...run,
        stream: (input) =>
          (async function* () {
            const fileId = await storeFile({
              threadId,
              fileName: "report.pdf",
              mimeType: "application/pdf",
            });
            reports.push({
              status: "uploaded",
              fileId,
              fileName: "report.pdf",
            });
            yield* run.stream(input);
          })(),
      };
      await client.sendUserMessage(Bun.randomUUIDv7(), "Write the report");
      await client.settle();
      expect(client.runtimeState().hasError).toBe(false);
      const reload = lastAnswerParts(await harness.reloadView(threadId));
      expect(fileParts(reload)).toHaveLength(1);
    } finally {
      client.dispose();
      await harness.close();
    }
  });

  test("a file that could not be shared is named live and after a reload", async () => {
    const { client, harness, local, threadId } = await openThread();
    try {
      local.run = localRunFor({
        threadId,
        text: "I could not attach it.",
        onStart: () => undefined,
        reports: () => [{ status: "failed", fileName: "data.zip" }],
      });
      await client.sendUserMessage(Bun.randomUUIDv7(), "Write the report");
      await client.settle();
      expect(client.runtimeState().hasError).toBe(false);
      const notShared = (
        messages: readonly { role: string; metadata?: unknown }[],
      ) =>
        asTestRaw<{ localRunFilesNotShared?: string[] } | undefined>(
          messages.findLast(({ role }) => role === "assistant")?.metadata,
        )?.localRunFilesNotShared;
      expect(notShared(client.messages())).toEqual(["data.zip"]);
      expect(notShared(await harness.reloadView(threadId))).toEqual([
        "data.zip",
      ]);
    } finally {
      client.dispose();
      await harness.close();
    }
  });

  test("a stored answer does not show its file twice when the page hands it back", async () => {
    const { client, harness, local, threadId } = await openThread();
    try {
      const reports: RunReport[] = [];
      const run = localRunFor({
        threadId,
        text: "Done.",
        onStart: () => undefined,
        reports: () => reports,
      });
      local.run = {
        ...run,
        stream: (input) =>
          (async function* () {
            const fileId = await storeFile({
              threadId,
              fileName: "report.pdf",
              mimeType: "application/pdf",
            });
            reports.push({
              status: "uploaded",
              fileId,
              fileName: "report.pdf",
            });
            yield* run.stream(input);
          })(),
      };
      await client.sendUserMessage(Bun.randomUUIDv7(), "Write the report");
      await client.settle();
      expect(fileParts(lastAnswerParts(client.messages()))).toHaveLength(1);
      // The next turn replays the page's messages through the same projection.
      local.run = undefined;
      harness.script(threadId, [
        { finishReason: "stop", text: "Noted.", type: "text" },
      ]);
      await client.sendUserMessage(Bun.randomUUIDv7(), "Thanks");
      await client.settle();
      const answers = client
        .messages()
        .filter(({ role }) => role === "assistant");
      expect(
        fileParts(asTestRaw<Part[]>(answers.at(0)?.parts ?? [])),
      ).toHaveLength(1);
    } finally {
      client.dispose();
      await harness.close();
    }
  });

  test("a later cloud turn keeps it on screen and off the model", async () => {
    const { client, harness, local, model, threadId } = await openThread();
    try {
      const fileName = "secret-report.pdf";
      const reports: RunReport[] = [];
      const run = localRunFor({
        threadId,
        text: "The report is ready.",
        onStart: () => undefined,
        reports: () => reports,
      });
      const gets = () =>
        fake.requests.filter(({ method }) => method === "GET").length;
      local.run = {
        ...run,
        stream: (input) =>
          (async function* () {
            const fileId = await storeFile({
              threadId,
              fileName,
              mimeType: "application/pdf",
            });
            reports.push({ status: "uploaded", fileId, fileName });
            yield* run.stream(input);
          })(),
      };
      await client.sendUserMessage(Bun.randomUUIDv7(), "Write the report");
      await client.settle();

      local.run = undefined;
      const readsBefore = gets();
      harness.script(threadId, [
        { finishReason: "stop", text: "Noted.", type: "text" },
      ]);
      await client.sendUserMessage(Bun.randomUUIDv7(), "Thanks");
      await client.settle();
      expect(client.runtimeState().hasError).toBe(false);
      // The object is never fetched: a missing one could not fail the turn.
      expect(gets()).toBe(readsBefore);

      const sent = JSON.stringify(model.promptsOf(threadId));
      expect(sent).toContain("The report is ready.");
      expect(sent).not.toContain(fileName);
      expect(sent).not.toContain("stella://file::");

      const reload = await harness.reloadView(threadId);
      const firstAnswer = reload.find(({ role }) => role === "assistant");
      expect(
        fileParts(asTestRaw<Part[]>(firstAnswer?.parts ?? [])),
      ).toHaveLength(1);
    } finally {
      client.dispose();
      await harness.close();
    }
  });

  test("the file the answer shows is the row's, whatever the report said", async () => {
    const { client, harness, local, threadId } = await openThread();
    try {
      const reports: RunReport[] = [];
      const run = localRunFor({
        threadId,
        text: "Done.",
        onStart: () => undefined,
        reports: () => reports,
      });
      local.run = {
        ...run,
        stream: (input) =>
          (async function* () {
            const fileId = await storeFile({
              threadId,
              fileName: "report.pdf",
              mimeType: "application/pdf",
            });
            reports.push({
              status: "uploaded",
              fileId,
              fileName: "renamed.exe",
            });
            yield* run.stream(input);
          })(),
      };
      await client.sendUserMessage(Bun.randomUUIDv7(), "Write the report");
      await client.settle();
      const [file] = fileParts(
        lastAnswerParts(await harness.reloadView(threadId)),
      );
      expect(file).toMatchObject({
        metadata: { filename: "report.pdf" },
        source: { mimeType: "application/pdf" },
      });
      expect(JSON.stringify(file)).toContain(
        toUserFileUrl(
          toSafeId<"userFile">((reports.at(0) as { fileId: string }).fileId),
        ),
      );
    } finally {
      client.dispose();
      await harness.close();
    }
  });
});
