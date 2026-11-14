import { panic, Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET,
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE,
  type ChatLocalRunStepContentKind,
  type ChatLocalRunStepContentStoredState,
  type ChatLocalRunStepTextKind,
} from "@stll/api-contract/chat-local-run-step-content";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  chatLocalRunStepContents,
  chatThreads,
  desktopRunnerRuns,
  userFiles,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { DESKTOP_RUNNER_OPEN_RUN_STATES } from "@/api/lib/desktop-runner/states";
import type { DesktopRunnerDb, RunOwner } from "@/api/lib/desktop-runner/store";
import { brandPersistedChatThreadId } from "@/api/lib/safe-id-boundaries";

/**
 * What the steps of a chat's local runs produced, as stella stores it: one
 * row per step of a thread, written on the gateway's owner connection for a
 * run that is still going, and read in the member's own scope, where the
 * database shows a step only with its thread. A step's text is encrypted for the
 * organization before it is written and opened only to answer its owner.
 *
 * Every write of a run first takes that run's row, so the writes of one run
 * settle one at a time against what the run may store
 * (`CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET`), and a step sent again settles
 * against what it stored before.
 */

const contents = chatLocalRunStepContents;
const runs = desktopRunnerRuns;
const { stored, tooLarge, runBudgetReached } =
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE;

type StepOptions = {
  owner: RunOwner;
  runId: string;
  /** SHA-256 hex of the step's chat call id. */
  stepKey: string;
};

/** How a step's content settled; `unknown_run` for a run that takes none. */
export type StepContentSettlement =
  | { type: "unknown_run" }
  | { type: "settled"; state: ChatLocalRunStepContentStoredState };

type HeldRun = {
  threadId: string;
  turnId: string;
  textBytes: number;
  images: number;
};

/**
 * Take the owner's run for one step's write: its row is locked until the
 * transaction ends, so what the run has stored is read and changed by one
 * writer at a time. `null` for a run of someone else, one that ended, or one
 * whose chat turn is gone.
 */
const holdRun = async (
  tx: Transaction,
  { owner, runId }: Pick<StepOptions, "owner" | "runId">,
): Promise<HeldRun | null> => {
  // audit: skip - takes the run's row for the write below; changes nothing
  const held = (
    await tx
      .update(runs)
      .set({ stepContentTextBytes: sql`${runs.stepContentTextBytes}` })
      .where(
        and(
          eq(runs.runId, runId),
          eq(runs.userId, owner.userId),
          eq(runs.organizationId, owner.organizationId),
          inArray(runs.state, DESKTOP_RUNNER_OPEN_RUN_STATES),
        ),
      )
      .returning({
        threadId: runs.chatThreadId,
        turnId: runs.chatTurnId,
        textBytes: runs.stepContentTextBytes,
        images: runs.stepContentImages,
      })
  ).at(0);
  if (held === undefined) {
    return null;
  }
  const { threadId, turnId, textBytes, images } = held;
  return threadId === null || turnId === null
    ? null
    : { threadId, turnId, textBytes, images };
};

const readStored = async (tx: Transaction, run: HeldRun, stepKey: string) =>
  (
    await tx
      .select({
        kind: contents.kind,
        state: contents.outcome,
        storedBytes: contents.storedBytes,
      })
      .from(contents)
      .where(
        and(eq(contents.threadId, run.threadId), eq(contents.stepKey, stepKey)),
      )
      .limit(1)
  ).at(0) ?? null;

/** A stored row's state, which the table's check holds to the stored states. */
const storedStateOf = (state: string): ChatLocalRunStepContentStoredState => {
  switch (state) {
    case stored:
      return stored;
    case tooLarge:
      return tooLarge;
    case runBudgetReached:
      return runBudgetReached;
    default:
      return panic("A stored step content row holds an unknown state");
  }
};

type StoreStepTextOptions = StepOptions & {
  kind: ChatLocalRunStepTextKind;
  /** How many bytes the step produced. */
  totalBytes: number;
  /** The kept start of the step's text, within the text cap. */
  text: string;
  /** UTF-8 bytes of `text`. */
  storedBytes: number;
};

/**
 * Store a step's text, replacing what the same step stored before. Past what
 * the run may store, the step keeps no text and says so. A step that already
 * stored an image keeps it.
 */
export const storeStepText = async (
  db: DesktopRunnerDb,
  {
    owner,
    runId,
    stepKey,
    kind,
    totalBytes,
    text,
    storedBytes,
  }: StoreStepTextOptions,
): Promise<StepContentSettlement> => {
  const sealed = await encryptContent(owner.organizationId, text);
  return await withAggregateTransaction(db, async (tx) => {
    const run = await holdRun(tx, { owner, runId });
    if (run === null) {
      return { type: "unknown_run" };
    }
    const previous = await readStored(tx, run, stepKey);
    if (previous?.kind === "image") {
      return { type: "settled", state: storedStateOf(previous.state) };
    }
    const previousBytes = previous?.storedBytes ?? 0;
    const withoutStep = run.textBytes - previousBytes;
    const fits =
      withoutStep + storedBytes <=
      CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET.textBytes;
    const row = fits
      ? {
          kind,
          outcome: stored,
          totalBytes,
          storedBytes,
          textEncrypted: sealed.ciphertext,
          textIv: sealed.iv,
        }
      : {
          kind,
          outcome: runBudgetReached,
          totalBytes,
          storedBytes: 0,
          textEncrypted: null,
          textIv: null,
        };
    // audit: skip - a turn's own output, stored with the turn the member ran
    await tx
      .insert(contents)
      .values({
        threadId: run.threadId,
        stepKey,
        runId,
        turnId: run.turnId,
        ...row,
      })
      .onConflictDoUpdate({
        target: [contents.threadId, contents.stepKey],
        set: row,
      });
    // audit: skip - run bookkeeping for the write above
    await tx
      .update(runs)
      .set({ stepContentTextBytes: withoutStep + row.storedBytes })
      .where(eq(runs.runId, runId));
    return { type: "settled", state: row.outcome };
  });
};

type UnstoredStepOptions = StepOptions & {
  kind: ChatLocalRunStepContentKind;
  totalBytes: number;
};

/**
 * Record a step whose content was too large to send (an image past its cap):
 * only its size is kept. A step that already settled keeps how it settled.
 */
export const recordStepTooLarge = async (
  db: DesktopRunnerDb,
  { owner, runId, stepKey, kind, totalBytes }: UnstoredStepOptions,
): Promise<StepContentSettlement> =>
  await withAggregateTransaction(db, async (tx) => {
    const run = await holdRun(tx, { owner, runId });
    if (run === null) {
      return { type: "unknown_run" };
    }
    const previous = await readStored(tx, run, stepKey);
    if (previous !== null) {
      return { type: "settled", state: storedStateOf(previous.state) };
    }
    // audit: skip - a turn's own output, stored with the turn the member ran
    await tx.insert(contents).values({
      threadId: run.threadId,
      stepKey,
      runId,
      turnId: run.turnId,
      kind,
      outcome: tooLarge,
      totalBytes,
      storedBytes: 0,
    });
    return { type: "settled", state: tooLarge };
  });

/** Whether a run has room for one more image before its bytes are stored. */
export type StepImageRoom =
  | { type: "unknown_run" }
  | { type: "settled"; state: ChatLocalRunStepContentStoredState }
  | { type: "room" };

/**
 * Decide, before an image's bytes are stored as a file, whether its step
 * takes one: not when the step already settled (an image step keeps its
 * first image), and not past the run's images, which the step then says.
 */
export const openStepImage = async (
  db: DesktopRunnerDb,
  { owner, runId, stepKey, totalBytes }: StepOptions & { totalBytes: number },
): Promise<StepImageRoom> =>
  await withAggregateTransaction(db, async (tx) => {
    const run = await holdRun(tx, { owner, runId });
    if (run === null) {
      return { type: "unknown_run" };
    }
    const previous = await readStored(tx, run, stepKey);
    if (previous !== null) {
      return { type: "settled", state: storedStateOf(previous.state) };
    }
    if (run.images < CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET.images) {
      return { type: "room" };
    }
    // audit: skip - a turn's own output, stored with the turn the member ran
    await tx.insert(contents).values({
      threadId: run.threadId,
      stepKey,
      runId,
      turnId: run.turnId,
      kind: "image",
      outcome: runBudgetReached,
      totalBytes,
      storedBytes: 0,
    });
    return { type: "settled", state: runBudgetReached };
  });

type StoreStepImageOptions = StepOptions & {
  /** The chat file the image was stored as, in the run's thread. */
  userFileId: SafeId<"userFile">;
  sizeBytes: number;
};

/** How an image settled, and whether the step now names the file. */
export type StepImageSettlement =
  | { type: "unknown_run" }
  | {
      type: "settled";
      state: ChatLocalRunStepContentStoredState;
      /** False when the step keeps another outcome; the file is the caller's to remove. */
      adopted: boolean;
    };

/**
 * Name a stored chat file as a step's image. The room is decided again here,
 * since `openStepImage` reserved none: a step that settled meanwhile, or a
 * run that filled, does not adopt the file. The file must be in the run's
 * own thread.
 */
export const storeStepImage = async (
  db: DesktopRunnerDb,
  { owner, runId, stepKey, userFileId, sizeBytes }: StoreStepImageOptions,
): Promise<StepImageSettlement> =>
  await withAggregateTransaction(db, async (tx) => {
    const run = await holdRun(tx, { owner, runId });
    if (run === null) {
      return { type: "unknown_run" };
    }
    const previous = await readStored(tx, run, stepKey);
    if (previous !== null) {
      return {
        type: "settled",
        state: storedStateOf(previous.state),
        adopted: false,
      };
    }
    const file = (
      await tx
        .select({ id: userFiles.id })
        .from(userFiles)
        .where(
          and(
            eq(userFiles.id, userFileId),
            eq(userFiles.threadId, brandPersistedChatThreadId(run.threadId)),
            eq(userFiles.userId, owner.userId),
          ),
        )
        .limit(1)
    ).at(0);
    if (file === undefined) {
      // Not a file of the run's own thread: the step names nothing.
      return { type: "unknown_run" };
    }
    const fits = run.images < CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET.images;
    // audit: skip - a turn's own output; the file's own create event audits it
    await tx.insert(contents).values({
      threadId: run.threadId,
      stepKey,
      runId,
      turnId: run.turnId,
      kind: "image",
      ...(fits
        ? {
            outcome: stored,
            totalBytes: sizeBytes,
            storedBytes: sizeBytes,
            userFileId,
          }
        : { outcome: runBudgetReached, totalBytes: sizeBytes, storedBytes: 0 }),
    });
    if (!fits) {
      return { type: "settled", state: runBudgetReached, adopted: false };
    }
    // audit: skip - run bookkeeping for the write above
    await tx
      .update(runs)
      .set({ stepContentImages: sql`${runs.stepContentImages} + 1` })
      .where(eq(runs.runId, runId));
    return { type: "settled", state: stored, adopted: true };
  });

type StepOfThread = {
  owner: RunOwner;
  threadId: SafeId<"chatThread">;
  stepKey: string;
};

/** What a thread the member sees holds for one step. */
export type VisibleStepContent =
  | { type: "none" }
  | {
      type: "unstored";
      state: Exclude<ChatLocalRunStepContentStoredState, "stored">;
      kind: string;
      totalBytes: number;
    }
  | {
      type: "text";
      kind: string;
      totalBytes: number;
      storedBytes: number;
      text: string;
    }
  | {
      type: "image";
      totalBytes: number;
      file: {
        id: SafeId<"userFile">;
        fileName: string;
        mimeType: string;
        placeholder: string | null;
      };
    };

/** A step's content as one read tells it apart, with nothing stored named. */
export type StoredStepContent =
  | Exclude<VisibleStepContent, { type: "none" }>
  | { type: "arriving" }
  | { type: "not_stored" };

/**
 * One step's content, read in the member's own scope: the database shows a
 * step only with its thread, so a thread the member cannot see (another
 * member's, another organization's, one whose matter they can no longer
 * open) answers `null`, and `none` means the thread is theirs and holds
 * nothing for the step. Text is opened for the member's organization.
 */
export const readVisibleStepContent = async (
  safeDb: SafeDb,
  { owner, threadId, stepKey }: StepOfThread,
): Promise<Result<VisibleStepContent | null, SafeDbError>> => {
  const read = await safeDb(
    async (tx) =>
      await tx
        .select({
          kind: contents.kind,
          outcome: contents.outcome,
          totalBytes: contents.totalBytes,
          storedBytes: contents.storedBytes,
          textEncrypted: contents.textEncrypted,
          textIv: contents.textIv,
          fileId: userFiles.id,
          fileName: userFiles.fileName,
          mimeType: userFiles.mimeType,
          placeholder: userFiles.placeholder,
        })
        .from(chatThreads)
        .leftJoin(
          contents,
          and(
            eq(contents.threadId, chatThreads.id),
            eq(contents.stepKey, stepKey),
          ),
        )
        .leftJoin(userFiles, eq(userFiles.id, contents.userFileId))
        .where(
          and(
            eq(chatThreads.id, threadId),
            eq(chatThreads.userId, owner.userId),
            eq(chatThreads.organizationId, owner.organizationId),
          ),
        )
        .limit(1)
        .then((rows) => rows.at(0) ?? null),
  );
  if (Result.isError(read)) {
    return Result.err(read.error);
  }
  const row = read.value;
  if (row === null) {
    return Result.ok(null);
  }
  if (
    row.kind === null ||
    row.outcome === null ||
    row.totalBytes === null ||
    row.storedBytes === null
  ) {
    return Result.ok({ type: "none" });
  }
  const state = storedStateOf(row.outcome);
  if (state !== stored) {
    return Result.ok({
      type: "unstored",
      state,
      kind: row.kind,
      totalBytes: row.totalBytes,
    });
  }
  if (row.textEncrypted !== null && row.textIv !== null) {
    return Result.ok({
      type: "text",
      kind: row.kind,
      totalBytes: row.totalBytes,
      storedBytes: row.storedBytes,
      text: await decryptContent(
        owner.organizationId,
        row.textEncrypted,
        row.textIv,
      ),
    });
  }
  if (row.fileId !== null && row.fileName !== null && row.mimeType !== null) {
    return Result.ok({
      type: "image",
      totalBytes: row.totalBytes,
      file: {
        id: row.fileId,
        fileName: row.fileName,
        mimeType: row.mimeType,
        placeholder: row.placeholder,
      },
    });
  }
  // The table's check gives a stored row its text or its file.
  return panic("A stored step content row holds neither text nor a file");
};

type StepRunOptions = {
  owner: RunOwner;
  threadId: SafeId<"chatThread">;
  /** The run the step's call id names. */
  runId: string;
};

/**
 * Whether the owner's run is still going in this thread, so a step of it
 * with nothing stored may yet be sent.
 */
export const isStepRunOpen = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, threadId, runId }: StepRunOptions,
): Promise<boolean> =>
  (
    await db
      .select({ runId: runs.runId })
      .from(runs)
      .where(
        and(
          eq(runs.runId, runId),
          eq(runs.chatThreadId, threadId),
          eq(runs.userId, owner.userId),
          eq(runs.organizationId, owner.organizationId),
          inArray(runs.state, DESKTOP_RUNNER_OPEN_RUN_STATES),
        ),
      )
      .limit(1)
  ).length === 1;
