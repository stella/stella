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
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

/**
 * What the steps of a chat's local runs produced, as stella stores it: one
 * row per step of a thread, written on the gateway's owner connection for a
 * run that is still going, and read in the member's own scope, where the
 * database shows a step only with its thread. A step's text is encrypted for the
 * organization before it is written and opened only to answer its owner.
 *
 * Every write of a run first takes that run's row, so the writes of one run
 * settle one at a time against what the run may store
 * (`CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET`). A step settles once: only the
 * run that wrote it is answered again, with how it settled, and nothing
 * replaces what it stored.
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

/**
 * Why a write is refused although its run is going: the step was stored by
 * another run of the thread, or it already settled with other content. A
 * step settles once; nothing rewrites it.
 */
type StepContentRefusal = "other_run" | "different_content";

/** How a step's content settled; `unknown_run` for a run that takes none. */
export type StepContentSettlement =
  | { type: "unknown_run" }
  | { type: "refused"; reason: StepContentRefusal }
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
        runId: contents.runId,
        kind: contents.kind,
        state: contents.outcome,
        textEncrypted: contents.textEncrypted,
        textIv: contents.textIv,
        fileSha256Hex: userFiles.sha256Hex,
      })
      .from(contents)
      .leftJoin(userFiles, eq(userFiles.id, contents.userFileId))
      .where(
        and(eq(contents.threadId, run.threadId), eq(contents.stepKey, stepKey)),
      )
      .limit(1)
  ).at(0) ?? null;

type StoredStep = NonNullable<Awaited<ReturnType<typeof readStored>>>;

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

type RepeatedStep = {
  previous: StoredStep;
  runId: string;
  kind: ChatLocalRunStepContentKind;
  /** Whether what is sent now is what the step stored. */
  sameContent: (previous: StoredStep) => boolean | Promise<boolean>;
};

/**
 * How a step that already has a row answers a write. Only the run that
 * wrote the row is answered at all; it gets how the step settled when it
 * sends the same thing again (a retry), and a refusal when it sends
 * anything else. A step that stored nothing keeps that outcome.
 */
const settleRepeat = async ({
  previous,
  runId,
  kind,
  sameContent,
}: RepeatedStep): Promise<
  Exclude<StepContentSettlement, { type: "unknown_run" }>
> => {
  if (previous.runId !== runId) {
    return { type: "refused", reason: "other_run" };
  }
  const state = storedStateOf(previous.state);
  if (previous.kind !== kind) {
    return { type: "refused", reason: "different_content" };
  }
  if (state !== stored || (await sameContent(previous))) {
    return { type: "settled", state };
  }
  return { type: "refused", reason: "different_content" };
};

/** Another run of the thread stored the step first, past this run's lock. */
const RACED_BY_ANOTHER_RUN = {
  type: "refused",
  reason: "other_run",
} as const satisfies StepContentSettlement;

/**
 * Insert a step's row; `false` when the step has one. A run's own writes
 * are serialized on its row, so only another run of the thread can have
 * written the step since this transaction read it.
 */
const insertStep = async (
  tx: Transaction,
  values: typeof contents.$inferInsert,
): Promise<boolean> => {
  // audit: skip - a turn's own output, stored with the turn the member ran; an image's file records its own create event
  const inserted = await tx
    .insert(contents)
    .values(values)
    .onConflictDoNothing({ target: [contents.threadId, contents.stepKey] })
    .returning({ stepKey: contents.stepKey });
  return inserted.length === 1;
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
 * Store a step's text, once. Past what the run may store, the step keeps no
 * text and says so. The same text sent again answers as stored; other text
 * for a step that settled is refused.
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
    if (previous !== null) {
      return await settleRepeat({
        previous,
        runId,
        kind,
        sameContent: async ({ textEncrypted, textIv }) =>
          textEncrypted !== null &&
          textIv !== null &&
          (await decryptContent(
            owner.organizationId,
            textEncrypted,
            textIv,
          )) === text,
      });
    }
    const fits =
      run.textBytes + storedBytes <=
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
      : { kind, outcome: runBudgetReached, totalBytes, storedBytes: 0 };
    const inserted = await insertStep(tx, {
      threadId: run.threadId,
      stepKey,
      runId,
      turnId: run.turnId,
      ...row,
    });
    if (!inserted) {
      return RACED_BY_ANOTHER_RUN;
    }
    if (fits) {
      // audit: skip - run bookkeeping for the write above
      await tx
        .update(runs)
        .set({ stepContentTextBytes: run.textBytes + storedBytes })
        .where(eq(runs.runId, runId));
    }
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
      // Content is never what a size-only report sends again.
      return await settleRepeat({
        previous,
        runId,
        kind,
        sameContent: () => false,
      });
    }
    const inserted = await insertStep(tx, {
      threadId: run.threadId,
      stepKey,
      runId,
      turnId: run.turnId,
      kind,
      outcome: tooLarge,
      totalBytes,
      storedBytes: 0,
    });
    if (!inserted) {
      return RACED_BY_ANOTHER_RUN;
    }
    return { type: "settled", state: tooLarge };
  });

type StepImageOptions = StepOptions & {
  /** SHA-256 hex of the image's bytes. */
  sha256Hex: string;
};

const sameImage =
  (sha256Hex: string) =>
  ({ fileSha256Hex }: StoredStep) =>
    fileSha256Hex === sha256Hex;

/** Whether a run has room for one more image before its bytes are stored. */
export type StepImageRoom =
  | Exclude<StepContentSettlement, { type: "settled" }>
  | { type: "settled"; state: ChatLocalRunStepContentStoredState }
  | { type: "room" };

/**
 * Decide, before an image's bytes are stored as a file, whether its step
 * takes one: not when the step already settled, and not past the run's
 * images, which the step then says.
 */
export const openStepImage = async (
  db: DesktopRunnerDb,
  {
    owner,
    runId,
    stepKey,
    sha256Hex,
    totalBytes,
  }: StepImageOptions & { totalBytes: number },
): Promise<StepImageRoom> =>
  await withAggregateTransaction(db, async (tx) => {
    const run = await holdRun(tx, { owner, runId });
    if (run === null) {
      return { type: "unknown_run" };
    }
    const previous = await readStored(tx, run, stepKey);
    if (previous !== null) {
      return await settleRepeat({
        previous,
        runId,
        kind: "image",
        sameContent: sameImage(sha256Hex),
      });
    }
    if (run.images < CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET.images) {
      return { type: "room" };
    }
    const inserted = await insertStep(tx, {
      threadId: run.threadId,
      stepKey,
      runId,
      turnId: run.turnId,
      kind: "image",
      outcome: runBudgetReached,
      totalBytes,
      storedBytes: 0,
    });
    if (!inserted) {
      return RACED_BY_ANOTHER_RUN;
    }
    return { type: "settled", state: runBudgetReached };
  });

type StoreStepImageOptions = StepImageOptions & {
  /** The chat file the image was stored as, in the run's thread. */
  userFileId: SafeId<"userFile">;
  sizeBytes: number;
};

/** How an image settled, and whether the step now names the file. */
export type StepImageSettlement =
  | Exclude<StepContentSettlement, { type: "settled" }>
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
  {
    owner,
    runId,
    stepKey,
    sha256Hex,
    userFileId,
    sizeBytes,
  }: StoreStepImageOptions,
): Promise<StepImageSettlement> =>
  await withAggregateTransaction(db, async (tx) => {
    const run = await holdRun(tx, { owner, runId });
    if (run === null) {
      return { type: "unknown_run" };
    }
    const previous = await readStored(tx, run, stepKey);
    if (previous !== null) {
      const repeat = await settleRepeat({
        previous,
        runId,
        kind: "image",
        sameContent: sameImage(sha256Hex),
      });
      return repeat.type === "settled"
        ? { type: "settled", state: repeat.state, adopted: false }
        : repeat;
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
    const inserted = await insertStep(tx, {
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
    if (!inserted) {
      return RACED_BY_ANOTHER_RUN;
    }
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
  /** A fork holds nothing for a step its source thread still stores. */
  | { type: "not_copied" }
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
 * nothing for the step; `not_copied` is that for a fork whose source thread
 * still stores the step. Text is opened for the member's organization.
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
          // A fork's source thread, where the member sees it, still storing
          // the step: the fork's copy of it is missing.
          sourceStores: sql<boolean>`EXISTS (SELECT 1 FROM chat_local_run_step_contents source_step WHERE source_step.thread_id = ${chatThreads.parentThreadId} AND source_step.step_key = ${stepKey})`,
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
    return Result.ok({ type: row.sourceStores ? "not_copied" : "none" });
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

/** One step a fork copies, and the fork's message that shows it. */
type CopiedStep = {
  stepKey: string;
  messageId: SafeId<"chatMessage">;
};

type CopyStepContentsOptions = {
  owner: RunOwner;
  sourceThreadId: SafeId<"chatThread">;
  targetThreadId: SafeId<"chatThread">;
  steps: readonly CopiedStep[];
};

/** Steps one statement copies: each adds two parameters. */
const COPY_STEPS_PER_STATEMENT = 200;

/**
 * Copy what the steps of a forked thread's messages stored, inside the
 * database: each copy is owned by the fork's message that shows the step, so
 * it goes with that message. Both threads must be the owner's. Text is
 * copied as stored (one organization encrypts both). An image row names the
 * fork's own copy of the step's file, found among the fork's files by the
 * bytes' hash; a step whose file the fork does not hold is left out, so the
 * fork never names the source's file.
 *
 * A row the fork already holds is kept, so the copy can be run again: a
 * repeat adds what an earlier one missed and changes nothing else. Returns
 * how many rows were added.
 */
export const copyStepContents = async (
  db: Pick<DesktopRunnerDb, "select" | "insert">,
  { owner, sourceThreadId, targetThreadId, steps }: CopyStepContentsOptions,
): Promise<number> => {
  const ownedThread = (threadId: SafeId<"chatThread">) =>
    sql`EXISTS (SELECT 1 FROM ${chatThreads} WHERE ${chatThreads.id} = ${threadId} AND ${chatThreads.userId} = ${owner.userId} AND ${chatThreads.organizationId} = ${owner.organizationId})`;
  const forkFile = sql`(SELECT fork_file.id FROM user_files fork_file JOIN user_files source_file ON source_file.id = ${contents.userFileId} WHERE fork_file.thread_id = ${targetThreadId} AND fork_file.user_id = ${owner.userId} AND fork_file.sha256_hex = source_file.sha256_hex ORDER BY fork_file.id LIMIT 1)`;
  let copied = 0;
  for (let from = 0; from < steps.length; from += COPY_STEPS_PER_STATEMENT) {
    const batch = steps.slice(from, from + COPY_STEPS_PER_STATEMENT);
    const rows = db
      .select({
        threadId: sql<string>`${targetThreadId}::uuid`.as("thread_id"),
        stepKey: contents.stepKey,
        runId: contents.runId,
        messageId: sqlCaseFragment({
          operand: sql`${contents.stepKey}`,
          branches: batch.map(
            (step) => sql`WHEN ${step.stepKey} THEN ${step.messageId}::uuid`,
          ),
          fallback: sql`NULL::uuid`,
        }).as("message_id"),
        kind: contents.kind,
        outcome: contents.outcome,
        totalBytes: contents.totalBytes,
        storedBytes: contents.storedBytes,
        textEncrypted: contents.textEncrypted,
        textIv: contents.textIv,
        userFileId: forkFile.as("user_file_id"),
      })
      .from(contents)
      .where(
        and(
          eq(contents.threadId, sourceThreadId),
          inArray(
            contents.stepKey,
            batch.map((step) => step.stepKey),
          ),
          ownedThread(sourceThreadId),
          ownedThread(targetThreadId),
          sql`(${contents.userFileId} IS NULL) = (${forkFile} IS NULL)`,
        ),
      );
    // audit: skip - copied history belongs to the fork's own thread create event
    const inserted = await db
      .insert(contents)
      .select(rows)
      .onConflictDoNothing()
      .returning({ stepKey: contents.stepKey });
    copied += inserted.length;
  }
  return copied;
};
