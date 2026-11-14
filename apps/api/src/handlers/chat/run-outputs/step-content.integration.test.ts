import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import {
  CHAT_LOCAL_RUN_STEP_CONTENT_CONFLICT_CODE,
  type ChatLocalRunStepContentKind,
  chatLocalRunStepContentUploadedSchema,
  chatLocalRunStepContentUploadPath,
} from "@stll/api-contract/chat-local-run-step-content";
import { CHAT_LOCAL_RUN_STEP_MAX_BYTES } from "@stll/api-contract/chat-local-run-step-output";
import { DESKTOP_RUNNER_PROTOCOL } from "@stll/api-contract/desktop-runner";

import type { SafeDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatThreads,
  chatTurns,
  desktopRunnerRuns,
  desktopRunners,
  userFiles,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import type { UploadUserFileDependencies } from "@/api/handlers/chat/upload-files";
import { routes } from "@/api/http/route";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, type SafeId, toSafeId } from "@/api/lib/branded-types";
import {
  openStepImage,
  readVisibleStepContent,
  recordStepTooLarge,
  storeStepImage,
  storeStepText,
} from "@/api/lib/desktop-runner/step-contents";
import {
  type DesktopRunnerDb,
  readOpenRunChatThread,
} from "@/api/lib/desktop-runner/store";
import { ImageDerivativeError } from "@/api/lib/files/image-derivative";
import { AGENT_RUN_TOKEN_PURPOSE } from "@/api/mcp/constants";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";
import type { TestServer } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createStoreRunStepContent } from "./step-content";

// timeout: an image goes through the real security scan and a fake object store.
setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let fake: FakeS3;
let server: TestServer;

type Claims = {
  sub: string;
  org_id: string;
  run_id?: string;
  purpose?: string;
  scope?: string;
  workspace_ids?: string[];
};

/** Tokens the fake verifier knows; anything else is refused as forged. */
const tokens = new Map<string, Claims>();

const tokenFor = (runId: string) => {
  const token = `token-${Bun.randomUUIDv7()}`;
  tokens.set(token, {
    sub: ids.userA1,
    org_id: ids.orgA,
    purpose: AGENT_RUN_TOKEN_PURPOSE,
    scope: "stella:read stella:chat",
    workspace_ids: [],
    run_id: runId,
  });
  return token;
};

// SAFETY: the test database exposes the same Drizzle query and transaction
// APIs as the owner connection the store runs on.
const runnerDb = () => asTestRaw<DesktopRunnerDb>(testDb);

type SeededRun = { runId: string; threadId: SafeId<"chatThread"> };

/** A local run of member A1, bound to a turn of a thread of theirs. */
const seedRun = async (
  state: "running" | "finished" = "running",
): Promise<SeededRun> => {
  const seen = new Date("2026-01-01T00:00:00.000Z");
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    title: "A turn on this computer",
  });
  const userMessageId = createSafeId<"chatMessage">();
  await testDb.insert(chatMessages).values({
    id: userMessageId,
    threadId,
    userId: ids.userA1,
    role: "user",
    content: toPersistedChatMessageContentV3({
      data: [{ type: "text", content: "Work on the matter" }],
    }),
  });
  const turnId = createSafeId<"chatTurn">();
  await testDb.insert(chatTurns).values({
    id: turnId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    threadId,
    userMessageId,
    status: "running",
    executionId: Bun.randomUUIDv7(),
    leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
  });
  const desktopId = Bun.randomUUIDv7();
  const deviceJkt = `jkt-${desktopId}`;
  await testDb.insert(desktopRunners).values({
    userId: ids.userA1,
    organizationId: ids.orgA,
    desktopId,
    deviceJkt,
    keyId: `key-${desktopId}`,
    sessionId: Bun.randomUUIDv7(),
    instanceId: "api-elsewhere",
    connection: "connected",
    protocol: DESKTOP_RUNNER_PROTOCOL.current,
    appVersion: "1.4.0",
    sidecarVersion: "1.4.0",
    harnesses: [],
    connectedAt: seen,
    lastSeenAt: seen,
  });
  const runId = Bun.randomUUIDv7();
  await testDb.insert(desktopRunnerRuns).values({
    runId,
    userId: ids.userA1,
    organizationId: ids.orgA,
    desktopId,
    deviceJkt,
    harness: "codex",
    harnessVersion: "1.0.0",
    workspaceIds: [],
    state,
    ...(state === "finished" ? { outcome: "completed" as const } : {}),
    leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    chatThreadId: threadId,
    chatTurnId: turnId,
  });
  return { runId, threadId };
};

let stepSeq = 0;
/** A step key no other test uses. */
const stepKey = () => {
  stepSeq += 1;
  return stepSeq.toString(16).padStart(64, "f");
};

type PutOptions = {
  token: string | null;
  kind: ChatLocalRunStepContentKind;
  totalBytes: number;
  content?: File;
};

const put = async (
  runId: string,
  key: string,
  { token, kind, totalBytes, content }: PutOptions,
) => {
  const body = new FormData();
  if (content !== undefined) {
    body.set("content", content);
  }
  const url = new URL(
    chatLocalRunStepContentUploadPath(runId, key),
    server.url,
  );
  url.searchParams.set("kind", kind);
  url.searchParams.set("totalBytes", String(totalBytes));
  return await fetch(url, {
    method: "PUT",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body,
  });
};

const stateOf = async (response: Response) => {
  expect(response.status).toBe(200);
  const answer: unknown = await response.json();
  return v.parse(chatLocalRunStepContentUploadedSchema, answer).state;
};

const read = async (run: SeededRun, key: string) => {
  const owner = { userId: ids.userA1, organizationId: ids.orgA };
  return (
    await readVisibleStepContent(
      // SAFETY: the test database exposes the same Drizzle query and
      // transaction APIs as the request connection the scope wraps.
      asTestRaw<SafeDb>(
        createSafeDb(testDb, [], owner.organizationId, owner.userId),
      ),
      { owner, threadId: run.threadId, stepKey: key },
    )
  ).unwrap();
};

const threadFiles = async (threadId: SafeId<"chatThread">) =>
  await testDb
    .select({ id: userFiles.id })
    .from(userFiles)
    .where(eq(userFiles.threadId, threadId));

/** The smallest PNG there is: one transparent pixel. */
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const text = (value: string) => new File([value], "content");

beforeAll(async () => {
  fake = startFakeS3();
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const store = createStoreRunStepContent({
    verifyToken: async (token) => {
      const claims = token === undefined ? undefined : tokens.get(token);
      if (claims === undefined) {
        // What the provider's verifier raises for a token it rejects.
        throw Object.assign(new Error("Invalid token"), {
          name: "APIError",
          status: "UNAUTHORIZED",
        });
      }
      return await Promise.resolve(claims);
    },
    resolveContext: async (session, { request }) => {
      const organizationId = toSafeId<"organization">(session.organizationId);
      const userId = toSafeId<"user">(session.userId);
      return await Promise.resolve({
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(testDb, [], organizationId, userId),
        ),
        recordAuditEvent: createAuditRecorder({
          organizationId,
          workspaceId: null,
          userId,
          request,
          server: null,
        }),
      });
    },
    readRunThread: async (options) =>
      Result.ok(await readOpenRunChatThread(testDb, options)),
    control: () => ({
      storeStepText: async (options) =>
        Result.ok(await storeStepText(runnerDb(), options)),
      recordStepTooLarge: async (options) =>
        Result.ok(await recordStepTooLarge(runnerDb(), options)),
      openStepImage: async (options) =>
        Result.ok(await openStepImage(runnerDb(), options)),
      storeStepImage: async (options) =>
        Result.ok(await storeStepImage(runnerDb(), options)),
    }),
    uploads: {
      // No thumbnail: `uploadUserFile` reserves a cleanup intent for the
      // image and another for its thumbnail in two statements of one
      // callsite, which a measured request refuses.
      generateImageThumbnail: async () =>
        await Promise.resolve(
          Result.err(
            new ImageDerivativeError({ message: "No thumbnail in this test" }),
          ),
        ),
      organizationFileUsageDb:
        asTestRaw<UploadUserFileDependencies["organizationFileUsageDb"]>(
          testDb,
        ),
    },
  });
  server = serveRoutesForTest(
    routes(
      { "/:runId/steps/:stepKey/content": { PUT: store } },
      { prefix: "/v1/chat/local-runs" },
    ),
  );
});

afterAll(async () => {
  await server.stop();
  fake.stop();
  await releaseRlsFixture();
});

describe("a run sending what a step produced", () => {
  test("stores a step's text for the run's thread", async () => {
    const run = await seedRun();
    const key = stepKey();
    const output = "$ bun test\n3 pass ✓\n";
    expect(
      await stateOf(
        await put(run.runId, key, {
          token: tokenFor(run.runId),
          kind: "command",
          totalBytes: Buffer.byteLength(output) + 100,
          content: text(output),
        }),
      ),
    ).toBe("stored");
    expect(await read(run, key)).toEqual({
      type: "text",
      kind: "command",
      totalBytes: Buffer.byteLength(output) + 100,
      storedBytes: Buffer.byteLength(output),
      text: output,
    });
  });

  test("a step is written once: a retry answers as stored, other text is refused", async () => {
    const run = await seedRun();
    const key = stepKey();
    const token = tokenFor(run.runId);
    const send = async (value: string) =>
      await put(run.runId, key, {
        token,
        kind: "command",
        totalBytes: Buffer.byteLength(value),
        content: text(value),
      });
    expect(await stateOf(await send("first"))).toBe("stored");
    expect(await stateOf(await send("first"))).toBe("stored");
    const rewrite = await send("other");
    expect(rewrite.status).toBe(409);
    const refusal: unknown = await rewrite.json();
    expect(refusal).toMatchObject({
      code: CHAT_LOCAL_RUN_STEP_CONTENT_CONFLICT_CODE,
    });
    expect(await read(run, key)).toMatchObject({ text: "first" });
  });

  test("refuses text that is not UTF-8, or more than its step produced", async () => {
    const run = await seedRun();
    const token = tokenFor(run.runId);
    const notUtf8 = await put(run.runId, stepKey(), {
      token,
      kind: "diff",
      totalBytes: 2,
      content: new File([Uint8Array.of(0xff, 0xfe)], "content"),
    });
    expect(notUtf8.status).toBe(422);
    const tooMuch = await put(run.runId, stepKey(), {
      token,
      kind: "diff",
      totalBytes: 2,
      content: text("abc"),
    });
    expect(tooMuch.status).toBe(422);
  });

  test("stores an image as a chat file of the thread, once per step", async () => {
    const run = await seedRun();
    const key = stepKey();
    const token = tokenFor(run.runId);
    const send = async () =>
      await put(run.runId, key, {
        token,
        kind: "image",
        totalBytes: PNG.byteLength,
        content: new File([PNG], "shot.png"),
      });
    expect(await stateOf(await send())).toBe("stored");
    const stored = await read(run, key);
    expect(stored).toMatchObject({
      type: "image",
      totalBytes: PNG.byteLength,
      file: { fileName: "shot.png", mimeType: "image/png" },
    });
    // The step sent again keeps its image, and the second copy is removed.
    expect(await stateOf(await send())).toBe("stored");
    expect(await read(run, key)).toEqual(stored);
    expect(await threadFiles(run.threadId)).toHaveLength(1);
  });

  test("an image is what its bytes are, whatever it is called", async () => {
    const run = await seedRun();
    const response = await put(run.runId, stepKey(), {
      token: tokenFor(run.runId),
      kind: "image",
      totalBytes: 5,
      content: new File(["hello"], "shot.png"),
    });
    expect(response.status).toBe(422);
    // Nor is a real image stored under a size that is not its own.
    const missized = await put(run.runId, stepKey(), {
      token: tokenFor(run.runId),
      kind: "image",
      totalBytes: PNG.byteLength + 1,
      content: new File([PNG], "shot.png"),
    });
    expect(missized.status).toBe(422);
    expect(await threadFiles(run.threadId)).toEqual([]);
  });

  test("an image past its cap sends only its size", async () => {
    const run = await seedRun();
    const key = stepKey();
    const token = tokenFor(run.runId);
    const totalBytes = CHAT_LOCAL_RUN_STEP_MAX_BYTES.image + 1;
    expect(
      await stateOf(
        await put(run.runId, key, { token, kind: "image", totalBytes }),
      ),
    ).toBe("too_large");
    expect(await read(run, key)).toEqual({
      type: "unstored",
      state: "too_large",
      kind: "image",
      totalBytes,
    });
    // Nothing else is sent without content.
    const empty = await put(run.runId, stepKey(), {
      token,
      kind: "command",
      totalBytes: 10,
    });
    expect(empty.status).toBe(422);
  });

  test("only the run's own token writes, and only while the run goes", async () => {
    const run = await seedRun();
    const other = await seedRun();
    const options = {
      kind: "command",
      totalBytes: 2,
      content: text("ok"),
    } as const;
    expect(
      (await put(run.runId, stepKey(), { ...options, token: null })).status,
    ).toBe(401);
    expect(
      (
        await put(run.runId, stepKey(), {
          ...options,
          token: tokenFor(other.runId),
        })
      ).status,
    ).toBe(403);
    const ended = await seedRun("finished");
    const key = stepKey();
    expect(
      (
        await put(ended.runId, key, {
          ...options,
          token: tokenFor(ended.runId),
        })
      ).status,
    ).toBe(404);
    expect(await read(ended, key)).toEqual({ type: "none" });
  });
});
