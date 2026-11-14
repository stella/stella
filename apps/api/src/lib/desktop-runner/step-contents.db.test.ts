import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET } from "@stll/api-contract/chat-local-run-step-content";
import { DESKTOP_RUNNER_PROTOCOL } from "@stll/api-contract/desktop-runner";
import { createTestClock } from "@stll/test-kit";

import type { SafeDb } from "@/api/db/safe-db";
import {
  chatLocalRunStepContents,
  chatMessages,
  chatThreads,
  chatTurns,
  desktopRunnerRuns,
  desktopRunners,
  userFiles,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { createSafeId, type SafeId, toSafeId } from "@/api/lib/branded-types";
import { queryCountLogger } from "@/api/lib/db-query-counter";
import {
  copyStepContents,
  isStepRunOpen,
  openStepImage,
  readVisibleStepContent,
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

/**
 * A running local run of `owner` for one turn of a thread of theirs. A thread
 * has one turn going at a time, and that turn may be read by more than one
 * run.
 */
const seedRunIn = async (
  owner: RunOwner,
  threadId: SafeId<"chatThread">,
  turnId: SafeId<"chatTurn">,
) => {
  const now = new Date(clock.now());
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
  return { runId };
};

/** A running local run of `owner`, bound to a turn of a thread of theirs. */
const seedRun = async (
  owner: RunOwner,
  dataWorkspaceIds: SafeId<"workspace">[] = [],
): Promise<SeededRun> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  await db.insert(chatThreads).values({
    id: threadId,
    organizationId: owner.organizationId,
    userId: owner.userId,
    title: "A turn on this computer",
    dataWorkspaceIds,
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
    // After the row's own creation time, which the database stamps.
    leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
  });
  const { runId } = await seedRunIn(owner, threadId, turnId);
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

/**
 * The member's own scoped connection, as a request of theirs holds it:
 * `openMatters` are the matters the request was authorized for.
 */
const scopedDb = (owner: RunOwner, openMatters: SafeId<"workspace">[] = []) =>
  // SAFETY: the test database exposes the same Drizzle query and transaction
  // APIs as the request connection the scope wraps.
  asTestRaw<SafeDb>(
    createSafeDb(db, openMatters, owner.organizationId, owner.userId),
  );

const read = async (
  owner: RunOwner,
  run: SeededRun,
  key: string,
  openMatters: SafeId<"workspace">[] = [],
) =>
  (
    await readVisibleStepContent(scopedDb(owner, openMatters), {
      owner,
      threadId: run.threadId,
      stepKey: key,
    })
  ).unwrap();

const runIsOpen = async (owner: RunOwner, run: SeededRun) =>
  await isStepRunOpen(runnerDb(), {
    owner,
    threadId: run.threadId,
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

const IMAGE_SHA = "a".repeat(64);
const OTHER_IMAGE_SHA = "b".repeat(64);

const seedImageFile = async (owner: RunOwner, run: SeededRun) => {
  const id = createSafeId<"userFile">();
  await db.insert(userFiles).values({
    id,
    userId: owner.userId,
    fileName: "shot.png",
    mimeType: "image/png",
    sizeBytes: 10,
    sha256Hex: IMAGE_SHA,
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

  test("a step with nothing stored may yet arrive only while its run goes", async () => {
    const run = await seedRun(ownerA);
    const key = stepKey();
    expect(await read(ownerA, run, key)).toEqual({ type: "none" });
    expect(await runIsOpen(ownerA, run)).toBe(true);
    // Another member's question about the same run finds none going.
    expect(await runIsOpen(ownerSameOrg, run)).toBe(false);
    await db
      .update(desktopRunnerRuns)
      .set({ state: "finished", outcome: "completed" })
      .where(eq(desktopRunnerRuns.runId, run.runId));
    expect(await runIsOpen(ownerA, run)).toBe(false);
    // A run that ended takes nothing more.
    expect(await storeText(ownerA, run, key, "late")).toEqual({
      type: "unknown_run",
    });
    expect(await read(ownerA, run, key)).toEqual({ type: "none" });
  });

  test("a member who can no longer open the thread's matter reads nothing", async () => {
    // Member A2 holds no membership of matter A1: the thread shows only to
    // a request authorized for that matter.
    const run = await seedRun(ownerSameOrg, [ids.wsA1]);
    const key = stepKey();
    await storeText(ownerSameOrg, run, key, "from the matter's files");
    expect(await read(ownerSameOrg, run, key, [ids.wsA1])).toMatchObject({
      type: "text",
      text: "from the matter's files",
    });
    expect(await read(ownerSameOrg, run, key)).toBeNull();
    // The row itself is hidden, not only the thread it is read with.
    const rows = (
      await scopedDb(ownerSameOrg)(
        async (tx) =>
          await tx
            .select({ stepKey: chatLocalRunStepContents.stepKey })
            .from(chatLocalRunStepContents)
            .where(eq(chatLocalRunStepContents.threadId, run.threadId)),
      )
    ).unwrap();
    expect(rows).toEqual([]);
  });

  test("the member's scope reads a step and never writes one", async () => {
    const run = await seedRun(ownerA);
    const key = stepKey();
    await storeText(ownerA, run, key, "kept");
    const removed = await scopedDb(ownerA)(
      async (tx) =>
        await tx
          .delete(chatLocalRunStepContents)
          .where(eq(chatLocalRunStepContents.threadId, run.threadId)),
    );
    expect(removed.isErr()).toBe(true);
    expect(await read(ownerA, run, key)).toMatchObject({ text: "kept" });
  });

  test("a step settles once: the same text again answers as stored, other text is refused", async () => {
    const run = await seedRun(ownerA);
    const key = stepKey();
    await storeText(ownerA, run, key, "first report");
    // A retry that sends the same bytes.
    expect(await storeText(ownerA, run, key, "first report")).toEqual({
      type: "settled",
      state: "stored",
    });
    expect(await storeText(ownerA, run, key, "rewritten")).toEqual({
      type: "refused",
      reason: "different_content",
    });
    expect(await read(ownerA, run, key)).toMatchObject({
      text: "first report",
    });
    expect(await countersOf(run.runId)).toMatchObject({
      textBytes: Buffer.byteLength("first report"),
    });
  });

  test("a run never writes a step another run of the thread stored", async () => {
    const earlier = await seedRun(ownerA);
    const key = stepKey();
    await storeText(ownerA, earlier, key, "what the earlier run printed");
    const later = await seedRunIn(ownerA, earlier.threadId, earlier.turnId);
    const refused = { type: "refused", reason: "other_run" } as const;
    // Neither other text nor the very same text: the step is not this run's.
    expect(await storeText(ownerA, later, key, "rewritten")).toEqual(refused);
    expect(
      await storeText(ownerA, later, key, "what the earlier run printed"),
    ).toEqual(refused);
    expect(
      await recordStepTooLarge(runnerDb(), {
        owner: ownerA,
        runId: later.runId,
        stepKey: key,
        kind: "image",
        totalBytes: 20_000_000,
      }),
    ).toEqual(refused);
    expect(
      await openStepImage(runnerDb(), {
        owner: ownerA,
        runId: later.runId,
        stepKey: key,
        sha256Hex: IMAGE_SHA,
        totalBytes: 10,
      }),
    ).toEqual(refused);
    expect(await read(ownerA, earlier, key)).toMatchObject({
      kind: "command",
      text: "what the earlier run printed",
    });
    expect(await countersOf(later.runId)).toEqual({ textBytes: 0, images: 0 });
    // The later run still stores its own steps in the same thread.
    expect(await storeText(ownerA, later, stepKey(), "its own")).toEqual({
      type: "settled",
      state: "stored",
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

  test("an image step names its file once, and no other image replaces it", async () => {
    const run = await seedRun(ownerA);
    const key = stepKey();
    const step = {
      owner: ownerA,
      runId: run.runId,
      stepKey: key,
      sha256Hex: IMAGE_SHA,
    };
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
    // The same image again (a retry) answers as stored and adopts nothing.
    const again = await seedImageFile(ownerA, run);
    expect(
      await openStepImage(runnerDb(), { ...step, totalBytes: 10 }),
    ).toEqual({ type: "settled", state: "stored" });
    expect(
      await storeStepImage(runnerDb(), {
        ...step,
        userFileId: again,
        sizeBytes: 10,
      }),
    ).toEqual({ type: "settled", state: "stored", adopted: false });
    // Another image for the step is refused: a step settles once.
    const refused = { type: "refused", reason: "different_content" } as const;
    expect(
      await openStepImage(runnerDb(), {
        ...step,
        sha256Hex: OTHER_IMAGE_SHA,
        totalBytes: 10,
      }),
    ).toEqual(refused);
    expect(
      await storeStepImage(runnerDb(), {
        ...step,
        sha256Hex: OTHER_IMAGE_SHA,
        userFileId: again,
        sizeBytes: 10,
      }),
    ).toEqual(refused);
    expect(await read(ownerA, run, key)).toMatchObject({ file: { id: first } });
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
        sha256Hex: IMAGE_SHA,
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
        sha256Hex: IMAGE_SHA,
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
    // as the request connection the scope wraps.
    const counted = asTestRaw<SafeDb>(
      createSafeDb(
        withQueryLogger(db, queryCountLogger),
        [],
        ownerA.organizationId,
        ownerA.userId,
      ),
    );
    const fixture = {
      safeDb: counted,
      owner: ownerA,
      threadId: run.threadId,
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

  test("a copy is made only between two threads of the same member", async () => {
    const source = await seedRun(ownerA);
    const key = stepKey();
    await storeText(ownerA, source, key, "not for anyone else");
    const foreign = await seedRun(ownerSameOrg);
    const steps = [{ stepKey: key, messageId: foreign.userMessageId }];
    // Another member cannot copy a step out of a thread that is not theirs,
    expect(
      await copyStepContents(runnerDb(), {
        owner: ownerSameOrg,
        sourceThreadId: source.threadId,
        targetThreadId: foreign.threadId,
        steps,
      }),
    ).toBe(0);
    // nor can the owner copy one into a thread that is not theirs.
    expect(
      await copyStepContents(runnerDb(), {
        owner: ownerA,
        sourceThreadId: source.threadId,
        targetThreadId: foreign.threadId,
        steps,
      }),
    ).toBe(0);
    expect(await read(ownerSameOrg, foreign, key)).toEqual({ type: "none" });
    // Between the owner's own threads the copy is made once.
    const own = await seedRun(ownerA);
    const ownSteps = [{ stepKey: key, messageId: own.userMessageId }];
    const copy = async () =>
      await copyStepContents(runnerDb(), {
        owner: ownerA,
        sourceThreadId: source.threadId,
        targetThreadId: own.threadId,
        steps: ownSteps,
      });
    expect(await copy()).toBe(1);
    expect(await copy()).toBe(0);
    expect(await read(ownerA, own, key)).toMatchObject({
      text: "not for anyone else",
    });
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
      sha256Hex: IMAGE_SHA,
      userFileId: file,
      sizeBytes: 10,
    });
    await db.delete(userFiles).where(eq(userFiles.id, file));
    expect(await fileExists(file)).toBe(false);
    expect(await read(ownerA, run, key)).toEqual({ type: "none" });
  });
});
