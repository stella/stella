import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET } from "@stll/api-contract/chat-local-run-step-content";
import { DESKTOP_RUNNER_PROTOCOL } from "@stll/api-contract/desktop-runner";
import { createTestClock } from "@stll/test-kit";

import {
  chatLocalRunStepContents,
  chatMessages,
  chatThreads,
  chatTurns,
  desktopRunnerRuns,
  desktopRunners,
  userFiles,
} from "@/api/db/schema";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { createSafeId, type SafeId, toSafeId } from "@/api/lib/branded-types";
import { queryCountLogger } from "@/api/lib/db-query-counter";
import {
  openStepImage,
  readStepContent,
  recordStepTooLarge,
  storeStepImage,
  storeStepText,
} from "@/api/lib/desktop-runner/step-contents";
import type { DesktopRunnerDb, RunOwner } from "@/api/lib/desktop-runner/store";
import { createUserFileKey } from "@/api/lib/file-key";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { chatLocalRunStepContentScalingScenario } from "@/api/tests/read-scaling/chat-local-run-step-content";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import {
  getTestDb,
  releaseTestDb,
  withQueryLogger,
} from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const ids = createTestIds();
const clock = createTestClock();
let db: TestDatabase;

const ownerA: RunOwner = { userId: ids.userA1, organizationId: ids.orgA };
const ownerSameOrg: RunOwner = { userId: ids.userA2, organizationId: ids.orgA };
const ownerOtherOrg: RunOwner = {
  userId: ids.userB1,
  organizationId: ids.orgB,
};

// SAFETY: the test database exposes the same Drizzle query and transaction
// APIs as the owner connection the store runs on.
const runnerDb = () => asTestRaw<DesktopRunnerDb>(db);

type SeededRun = {
  runId: string;
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
  userMessageId: SafeId<"chatMessage">;
};

/** A running local run of `owner`, bound to a turn of a thread of theirs. */
const seedRun = async (owner: RunOwner): Promise<SeededRun> => {
  const now = new Date(clock.now());
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  await db.insert(chatThreads).values({
    id: threadId,
    organizationId: owner.organizationId,
    userId: owner.userId,
    title: "A turn on this computer",
  });
  const userMessageId = createSafeId<"chatMessage">();
  await db.insert(chatMessages).values({
    id: userMessageId,
    threadId,
    userId: owner.userId,
    role: "user",
    content: toPersistedChatMessageContentV3({
      data: [{ type: "text", content: "Work on the matter" }],
    }),
  });
  const turnId = createSafeId<"chatTurn">();
  await db.insert(chatTurns).values({
    id: turnId,
    organizationId: owner.organizationId,
    userId: owner.userId,
    threadId,
    userMessageId,
    status: "running",
    executionId: Bun.randomUUIDv7(),
    leaseExpiresAt: new Date(now.getTime() + 60_000),
  });
  const desktopId = Bun.randomUUIDv7();
  const deviceJkt = `jkt-${desktopId}`;
  await db.insert(desktopRunners).values({
    userId: owner.userId,
    organizationId: owner.organizationId,
    desktopId,
    deviceJkt,
    keyId: `key-${desktopId}`,
    sessionId: Bun.randomUUIDv7(),
    instanceId: "api-test",
    connection: "connected",
    protocol: DESKTOP_RUNNER_PROTOCOL.current,
    appVersion: "1.4.0",
    sidecarVersion: "1.4.0",
    harnesses: [],
    connectedAt: now,
    lastSeenAt: now,
  });
  const runId = Bun.randomUUIDv7();
  await db.insert(desktopRunnerRuns).values({
    runId,
    userId: owner.userId,
    organizationId: owner.organizationId,
    desktopId,
    deviceJkt,
    harness: "claude-code",
    harnessVersion: "2.1.309",
    workspaceIds: [],
    state: "running",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    chatThreadId: threadId,
    chatTurnId: turnId,
  });
  return { runId, threadId, turnId, userMessageId };
};

let stepSeq = 0;
/** A step key no other test uses. */
const stepKey = () => {
  stepSeq += 1;
  return stepSeq.toString(16).padStart(64, "0");
};

const storeText = async (
  owner: RunOwner,
  run: Pick<SeededRun, "runId">,
  key: string,
  text: string,
) =>
  await storeStepText(runnerDb(), {
    owner,
    runId: run.runId,
    stepKey: key,
    kind: "command",
    totalBytes: Buffer.byteLength(text),
    text,
    storedBytes: Buffer.byteLength(text),
  });

const read = async (owner: RunOwner, run: SeededRun, key: string) =>
  await readStepContent(runnerDb(), {
    owner,
    threadId: run.threadId,
    stepKey: key,
    runId: run.runId,
  });

const countersOf = async (runId: string) =>
  (
    await db
      .select({
        textBytes: desktopRunnerRuns.stepContentTextBytes,
        images: desktopRunnerRuns.stepContentImages,
      })
      .from(desktopRunnerRuns)
      .where(eq(desktopRunnerRuns.runId, runId))
  ).at(0);

const seedImageFile = async (owner: RunOwner, run: SeededRun) => {
  const id = createSafeId<"userFile">();
  await db.insert(userFiles).values({
    id,
    userId: owner.userId,
    fileName: "shot.png",
    mimeType: "image/png",
    sizeBytes: 10,
    sha256Hex: "a".repeat(64),
    s3Key: createUserFileKey({
      fileId: id,
      mimeType: "image/png",
      organizationId: owner.organizationId,
    }),
    threadId: run.threadId,
  });
  return id;
};

const fileExists = async (id: SafeId<"userFile">) =>
  (
    await db
      .select({ id: userFiles.id })
      .from(userFiles)
      .where(eq(userFiles.id, id))
  ).length === 1;

// timeout: seeding the shared RLS fixtures runs many inserts on a cold database
beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);
}, 30_000);
afterAll(releaseTestDb);

describe("the stored content of a local run's steps", () => {
  test("a step's text is stored for its run and read back by its owner", async () => {
    const run = await seedRun(ownerA);
    const key = stepKey();
    expect(await storeText(ownerA, run, key, "ok ✓\n")).toEqual({
      type: "settled",
      state: "stored",
    });
    expect(await read(ownerA, run, key)).toEqual({
      type: "text",
      kind: "command",
      totalBytes: Buffer.byteLength("ok ✓\n"),
      storedBytes: Buffer.byteLength("ok ✓\n"),
      text: "ok ✓\n",
    });
    expect(await countersOf(run.runId)).toEqual({
      textBytes: Buffer.byteLength("ok ✓\n"),
      images: 0,
    });
  });

  test("no other member and no other organization writes or reads it", async () => {
    const run = await seedRun(ownerA);
    const key = stepKey();
    await storeText(ownerA, run, key, "secret output");
    for (const other of [ownerSameOrg, ownerOtherOrg]) {
      expect(await storeText(other, run, stepKey(), "x")).toEqual({
        type: "unknown_run",
      });
      expect(await read(other, run, key)).toBeNull();
    }
    expect(await read(ownerA, run, key)).toMatchObject({
      text: "secret output",
    });
  });

  test("a step with nothing stored is arriving while its run goes, then not stored", async () => {
    const run = await seedRun(ownerA);
    const key = stepKey();
    expect(await read(ownerA, run, key)).toEqual({ type: "arriving" });
    await db
      .update(desktopRunnerRuns)
      .set({ state: "finished", outcome: "completed" })
      .where(eq(desktopRunnerRuns.runId, run.runId));
    expect(await read(ownerA, run, key)).toEqual({ type: "not_stored" });
    // A run that ended takes nothing more.
    expect(await storeText(ownerA, run, key, "late")).toEqual({
      type: "unknown_run",
    });
    expect(await read(ownerA, run, key)).toEqual({ type: "not_stored" });
  });

  test("a step sent again replaces its text and is counted once", async () => {
    const run = await seedRun(ownerA);
    const key = stepKey();
    await storeText(ownerA, run, key, "first report");
    await storeText(ownerA, run, key, "second");
    expect(await read(ownerA, run, key)).toMatchObject({ text: "second" });
    expect(await countersOf(run.runId)).toMatchObject({
      textBytes: Buffer.byteLength("second"),
    });
  });

  test("past what a run may store, a step keeps no text and says so", async () => {
    const run = await seedRun(ownerA);
    const budget = CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET.textBytes;
    await db
      .update(desktopRunnerRuns)
      .set({ stepContentTextBytes: budget - 3 })
      .where(eq(desktopRunnerRuns.runId, run.runId));
    const fits = stepKey();
    const over = stepKey();
    expect(await storeText(ownerA, run, over, "four")).toEqual({
      type: "settled",
      state: "run_budget_reached",
    });
    expect(await read(ownerA, run, over)).toEqual({
      type: "unstored",
      state: "run_budget_reached",
      kind: "command",
      totalBytes: 4,
    });
    expect(await countersOf(run.runId)).toMatchObject({
      textBytes: budget - 3,
    });
    expect(await storeText(ownerA, run, fits, "abc")).toEqual({
      type: "settled",
      state: "stored",
    });
    expect(await countersOf(run.runId)).toMatchObject({ textBytes: budget });
  });

  test("an image step names its file once and keeps its first image", async () => {
    const run = await seedRun(ownerA);
    const key = stepKey();
    const step = { owner: ownerA, runId: run.runId, stepKey: key };
    expect(
      await openStepImage(runnerDb(), { ...step, totalBytes: 10 }),
    ).toEqual({ type: "room" });
    const first = await seedImageFile(ownerA, run);
    expect(
      await storeStepImage(runnerDb(), {
        ...step,
        userFileId: first,
        sizeBytes: 10,
      }),
    ).toEqual({ type: "settled", state: "stored", adopted: true });
    expect(await read(ownerA, run, key)).toEqual({
      type: "image",
      totalBytes: 10,
      file: {
        id: first,
        fileName: "shot.png",
        mimeType: "image/png",
        placeholder: null,
      },
    });
    const second = await seedImageFile(ownerA, run);
    expect(
      await openStepImage(runnerDb(), { ...step, totalBytes: 10 }),
    ).toEqual({ type: "settled", state: "stored" });
    expect(
      await storeStepImage(runnerDb(), {
        ...step,
        userFileId: second,
        sizeBytes: 10,
      }),
    ).toEqual({ type: "settled", state: "stored", adopted: false });
    expect(await countersOf(run.runId)).toMatchObject({ images: 1 });
  });

  test("a file of another thread is never adopted as a step's image", async () => {
    const run = await seedRun(ownerA);
    const elsewhere = await seedRun(ownerA);
    const foreign = await seedImageFile(ownerA, elsewhere);
    expect(
      await storeStepImage(runnerDb(), {
        owner: ownerA,
        runId: run.runId,
        stepKey: stepKey(),
        userFileId: foreign,
        sizeBytes: 10,
      }),
    ).toEqual({ type: "unknown_run" });
    expect(await countersOf(run.runId)).toMatchObject({ images: 0 });
  });

  test("past a run's images, an image step stores none and says so", async () => {
    const run = await seedRun(ownerA);
    await db
      .update(desktopRunnerRuns)
      .set({
        stepContentImages: CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET.images,
      })
      .where(eq(desktopRunnerRuns.runId, run.runId));
    const key = stepKey();
    expect(
      await openStepImage(runnerDb(), {
        owner: ownerA,
        runId: run.runId,
        stepKey: key,
        totalBytes: 10,
      }),
    ).toEqual({ type: "settled", state: "run_budget_reached" });
    expect(await read(ownerA, run, key)).toEqual({
      type: "unstored",
      state: "run_budget_reached",
      kind: "image",
      totalBytes: 10,
    });
  });

  test("an image past its cap keeps only its size", async () => {
    const run = await seedRun(ownerA);
    const key = stepKey();
    expect(
      await recordStepTooLarge(runnerDb(), {
        owner: ownerA,
        runId: run.runId,
        stepKey: key,
        kind: "image",
        totalBytes: 20_000_000,
      }),
    ).toEqual({ type: "settled", state: "too_large" });
    expect(await read(ownerA, run, key)).toEqual({
      type: "unstored",
      state: "too_large",
      kind: "image",
      totalBytes: 20_000_000,
    });
  });

  test("reading one step costs the same however many steps its thread holds", async () => {
    const run = await seedRun(ownerA);
    const key = stepKey();
    await storeText(ownerA, run, key, "measured");
    // SAFETY: the counted test database exposes the same Drizzle query APIs
    // as the owner connection the store runs on.
    const counted = asTestRaw<DesktopRunnerDb>(
      withQueryLogger(db, queryCountLogger),
    );
    const fixture = {
      control: {
        readStepContent: async (
          options: Parameters<typeof readStepContent>[1],
        ) => Result.ok(await readStepContent(counted, options)),
      },
      owner: ownerA,
      threadId: run.threadId,
      runId: run.runId,
      stepKey: key,
    };
    const small = await chatLocalRunStepContentScalingScenario.measure(fixture);
    for (let index = 0; index < 20; index += 1) {
      await storeText(ownerA, run, stepKey(), "x".repeat(2000));
    }
    const large = await chatLocalRunStepContentScalingScenario.measure(fixture);
    expect(small.rows).toBe(1);
    expect(readScalingViolations({ small, large })).toEqual([]);
  });

  test("deleting the message a turn answers deletes its steps' content", async () => {
    const run = await seedRun(ownerA);
    const key = stepKey();
    await storeText(ownerA, run, key, "gone with the message");
    await db
      .delete(chatMessages)
      .where(
        and(
          eq(chatMessages.id, run.userMessageId),
          eq(chatMessages.threadId, run.threadId),
        ),
      );
    expect(
      await db
        .select({ stepKey: chatLocalRunStepContents.stepKey })
        .from(chatLocalRunStepContents)
        .where(eq(chatLocalRunStepContents.threadId, run.threadId)),
    ).toEqual([]);
  });

  test("deleting a step's image file deletes the step's row", async () => {
    const run = await seedRun(ownerA);
    const key = stepKey();
    const file = await seedImageFile(ownerA, run);
    await storeStepImage(runnerDb(), {
      owner: ownerA,
      runId: run.runId,
      stepKey: key,
      userFileId: file,
      sizeBytes: 10,
    });
    await db.delete(userFiles).where(eq(userFiles.id, file));
    expect(await fileExists(file)).toBe(false);
    expect(await read(ownerA, run, key)).toEqual({ type: "arriving" });
  });
});
