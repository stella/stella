import { panic, Result } from "better-result";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import {
  CHAT_LOCAL_RUN_AWAITED_STEP_REFUSAL,
  CHAT_LOCAL_RUN_STEP_AWAITED_MS,
  CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET,
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE,
  type ChatLocalRunAwaitedStepRefusal,
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

/**
 * Who writes a step.
 *
 * - `run`: the run itself, by its agent token, while it is going.
 * - `computer`: the computer a run ran on, after the run's end, for a step
 *   the run announced it still had to send (`awaited`). Proven by the
 *   computer's own credential and device key, checked against the run's row.
 */
export type StepWriter =
  | { type: "run"; owner: RunOwner; runId: string }
  | {
      type: "computer";
      owner: RunOwner;
      runId: string;
      desktopId: string;
      deviceJkt: string;
      /** The moment the write is judged at; an awaited step has its time. */
      now: Date;
    };

type StepOptions = {
  writer: StepWriter;
  /** SHA-256 hex of the step's chat call id. */
  stepKey: string;
};

/**
 * Why a write is refused although its run is known: the step was stored by
 * another run of the thread, or it already settled with other content (a
 * step settles once; nothing rewrites it); or, after the run's end, one of
 * the reasons of `CHAT_LOCAL_RUN_AWAITED_STEP_REFUSAL`.
 */
type StepContentRefusal =
  "other_run" | "different_content" | ChatLocalRunAwaitedStepRefusal;

/** How a step's content settled; `unknown_run` for a run that takes none. */
export type StepContentSettlement =
  | { type: "unknown_run" }
  | { type: "refused"; reason: StepContentRefusal }
  | { type: "settled"; state: ChatLocalRunStepContentStoredState };

type Refused = Extract<StepContentSettlement, { type: "refused" }>;

const AWAITED = "awaited";

type HeldRun = {
  runId: string;
  threadId: string;
  turnId: string;
  textBytes: number;
  images: number;
};

/**
 * Take the writer's run for one step's write: its row is locked until the
 * transaction ends, so what the run has stored is read and changed by one
 * writer at a time. A run writes only while it is going; its computer writes
 * for it once it is over, and only the computer the run's row names.
 */
const holdRun = async (
  tx: Transaction,
  writer: StepWriter,
): Promise<HeldRun | Refused | null> => {
  const { owner, runId } = writer;
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
          writer.type === "run"
            ? inArray(runs.state, DESKTOP_RUNNER_OPEN_RUN_STATES)
            : undefined,
        ),
      )
      .returning({
        threadId: runs.chatThreadId,
        turnId: runs.chatTurnId,
        textBytes: runs.stepContentTextBytes,
        images: runs.stepContentImages,
        desktopId: runs.desktopId,
        deviceJkt: runs.deviceJkt,
      })
  ).at(0);
  if (held === undefined) {
    return null;
  }
  if (
    writer.type === "computer" &&
    (held.desktopId !== writer.desktopId || held.deviceJkt !== writer.deviceJkt)
  ) {
    return {
      type: "refused",
      reason: CHAT_LOCAL_RUN_AWAITED_STEP_REFUSAL.otherComputer,
    };
  }
  const { threadId, turnId, textBytes, images } = held;
  return threadId === null || turnId === null
    ? null
    : { runId, threadId, turnId, textBytes, images };
};

const readStored = async (tx: Transaction, run: HeldRun, stepKey: string) =>
  (
    await tx
      .select({
        runId: contents.runId,
        kind: contents.kind,
        state: contents.outcome,
        createdAt: contents.createdAt,
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

type Repeat = {
  kind: ChatLocalRunStepContentKind;
  /** Whether what is sent now is what the step stored. */
  sameContent: (previous: StoredStep) => boolean | Promise<boolean>;
};

/**
 * Whether the writer may write the step now: `null` when it may, else how
 * its write is answered without writing.
 *
 * A run writes a step that has no row. For a step that has one, only the run
 * that wrote it is answered at all: with how the step settled when it sends
 * the same thing again (a retry), and a refusal when it sends anything else.
 *
 * A computer writes, after its run's end, only a step that run announced and
 * that is still awaited, inside the time an awaited step has.
 */
const gateWrite = async (
  writer: StepWriter,
  run: HeldRun,
  previous: StoredStep | null,
  { kind, sameContent }: Repeat,
): Promise<Exclude<StepContentSettlement, { type: "unknown_run" }> | null> => {
  const awaited = previous?.state === AWAITED && previous.runId === run.runId;
  if (writer.type === "computer") {
    if (!awaited) {
      return {
        type: "refused",
        reason: CHAT_LOCAL_RUN_AWAITED_STEP_REFUSAL.notAwaited,
      };
    }
    return writer.now.getTime() - previous.createdAt.getTime() >
      CHAT_LOCAL_RUN_STEP_AWAITED_MS
      ? {
          type: "refused",
          reason: CHAT_LOCAL_RUN_AWAITED_STEP_REFUSAL.windowClosed,
        }
      : null;
  }
  if (previous === null || awaited) {
    return null;
  }
  if (previous.runId !== run.runId) {
    return { type: "refused", reason: "other_run" };
  }
  if (previous.state === AWAITED || previous.kind !== kind) {
    return { type: "refused", reason: "different_content" };
  }
  const state = storedStateOf(previous.state);
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

type StepRow = Omit<
  typeof contents.$inferInsert,
  "threadId" | "stepKey" | "runId" | "turnId" | "messageId"
>;

/**
 * Write a step's row: a new one, or in place of the row that awaited it.
 * `false` when the step has a settled row. A run's own writes are serialized
 * on its row, so only another run of the thread can have settled the step
 * since this transaction read it.
 */
const writeStep = async (
  tx: Transaction,
  run: HeldRun,
  stepKey: string,
  row: StepRow,
): Promise<boolean> => {
  // audit: skip - a turn's own output, stored with the turn the member ran; an image's file records its own create event
  const written = await tx
    .insert(contents)
    .values({
      threadId: run.threadId,
      stepKey,
      runId: run.runId,
      turnId: run.turnId,
      ...row,
    })
    .onConflictDoUpdate({
      target: [contents.threadId, contents.stepKey],
      set: row,
      setWhere: and(
        eq(contents.outcome, AWAITED),
        eq(contents.runId, run.runId),
      ),
    })
    .returning({ stepKey: contents.stepKey });
  return written.length === 1;
};

/** The run a write is for, or how the write is answered without one. */
const heldOr = (
  held: HeldRun | Refused | null,
): { run: HeldRun } | { answer: Refused | { type: "unknown_run" } } => {
  if (held === null) {
    return { answer: { type: "unknown_run" } };
  }
  return "type" in held ? { answer: held } : { run: held };
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
    writer,
    stepKey,
    kind,
    totalBytes,
    text,
    storedBytes,
  }: StoreStepTextOptions,
): Promise<StepContentSettlement> => {
  const { organizationId } = writer.owner;
  const sealed = await encryptContent(organizationId, text);
  return await withAggregateTransaction(db, async (tx) => {
    const held = heldOr(await holdRun(tx, writer));
    if ("answer" in held) {
      return held.answer;
    }
    const { run } = held;
    const gate = await gateWrite(
      writer,
      run,
      await readStored(tx, run, stepKey),
      {
        kind,
        sameContent: async ({ textEncrypted, textIv }) =>
          textEncrypted !== null &&
          textIv !== null &&
          (await decryptContent(organizationId, textEncrypted, textIv)) ===
            text,
      },
    );
    if (gate !== null) {
      return gate;
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
    if (!(await writeStep(tx, run, stepKey, row))) {
      return RACED_BY_ANOTHER_RUN;
    }
    if (fits) {
      // audit: skip - run bookkeeping for the write above
      await tx
        .update(runs)
        .set({ stepContentTextBytes: run.textBytes + storedBytes })
        .where(eq(runs.runId, run.runId));
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
  { writer, stepKey, kind, totalBytes }: UnstoredStepOptions,
): Promise<StepContentSettlement> =>
  await withAggregateTransaction(db, async (tx) => {
    const held = heldOr(await holdRun(tx, writer));
    if ("answer" in held) {
      return held.answer;
    }
    const { run } = held;
    const gate = await gateWrite(
      writer,
      run,
      await readStored(tx, run, stepKey),
      {
        kind,
        // Content is never what a size-only report sends again.
        sameContent: () => false,
      },
    );
    if (gate !== null) {
      return gate;
    }
    const written = await writeStep(tx, run, stepKey, {
      kind,
      outcome: tooLarge,
      totalBytes,
      storedBytes: 0,
    });
    return written
      ? { type: "settled", state: tooLarge }
      : RACED_BY_ANOTHER_RUN;
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
  | { type: "room"; threadId: SafeId<"chatThread"> };

/**
 * Decide, before an image's bytes are stored as a file, whether its step
 * takes one: not when the step already settled, and not past the run's
 * images, which the step then says. `room` names the run's thread, where the
 * file belongs.
 */
export const openStepImage = async (
  db: DesktopRunnerDb,
  {
    writer,
    stepKey,
    sha256Hex,
    totalBytes,
  }: StepImageOptions & { totalBytes: number },
): Promise<StepImageRoom> =>
  await withAggregateTransaction(db, async (tx) => {
    const held = heldOr(await holdRun(tx, writer));
    if ("answer" in held) {
      return held.answer;
    }
    const { run } = held;
    const gate = await gateWrite(
      writer,
      run,
      await readStored(tx, run, stepKey),
      {
        kind: "image",
        sameContent: sameImage(sha256Hex),
      },
    );
    if (gate !== null) {
      return gate;
    }
    if (run.images < CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET.images) {
      return {
        type: "room",
        threadId: brandPersistedChatThreadId(run.threadId),
      };
    }
    const written = await writeStep(tx, run, stepKey, {
      kind: "image",
      outcome: runBudgetReached,
      totalBytes,
      storedBytes: 0,
    });
    return written
      ? { type: "settled", state: runBudgetReached }
      : RACED_BY_ANOTHER_RUN;
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
  { writer, stepKey, sha256Hex, userFileId, sizeBytes }: StoreStepImageOptions,
): Promise<StepImageSettlement> =>
  await withAggregateTransaction(db, async (tx) => {
    const held = heldOr(await holdRun(tx, writer));
    if ("answer" in held) {
      return held.answer;
    }
    const { run } = held;
    const gate = await gateWrite(
      writer,
      run,
      await readStored(tx, run, stepKey),
      {
        kind: "image",
        sameContent: sameImage(sha256Hex),
      },
    );
    if (gate !== null) {
      return gate.type === "settled"
        ? { type: "settled", state: gate.state, adopted: false }
        : gate;
    }
    const file = (
      await tx
        .select({ id: userFiles.id })
        .from(userFiles)
        .where(
          and(
            eq(userFiles.id, userFileId),
            eq(userFiles.threadId, brandPersistedChatThreadId(run.threadId)),
            eq(userFiles.userId, writer.owner.userId),
          ),
        )
        .limit(1)
    ).at(0);
    if (file === undefined) {
      // Not a file of the run's own thread: the step names nothing.
      return { type: "unknown_run" };
    }
    const fits = run.images < CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET.images;
    const written = await writeStep(
      tx,
      run,
      stepKey,
      fits
        ? {
            kind: "image",
            outcome: stored,
            totalBytes: sizeBytes,
            storedBytes: sizeBytes,
            userFileId,
          }
        : {
            kind: "image",
            outcome: runBudgetReached,
            totalBytes: sizeBytes,
            storedBytes: 0,
          },
    );
    if (!written) {
      return RACED_BY_ANOTHER_RUN;
    }
    if (!fits) {
      return { type: "settled", state: runBudgetReached, adopted: false };
    }
    // audit: skip - run bookkeeping for the write above
    await tx
      .update(runs)
      .set({ stepContentImages: sql`${runs.stepContentImages} + 1` })
      .where(eq(runs.runId, run.runId));
    return { type: "settled", state: stored, adopted: true };
  });

type AwaitedStepsOptions = {
  owner: RunOwner;
  runId: string;
  /** The keys the run announced it still has to send. */
  stepKeys: readonly string[];
};

/**
 * Record the steps a run announced, just before its finish, that it still
 * has to send: each gets a row that awaits its content. A step that already
 * has a row keeps it. The announcement is read from the run's own stored
 * events, which the run wrote while it was going, so the run may be over by
 * now. Returns how many steps are newly awaited.
 */
export const recordAwaitedSteps = async (
  db: Pick<DesktopRunnerDb, "select" | "insert">,
  { owner, runId, stepKeys }: AwaitedStepsOptions,
): Promise<number> => {
  const run = (
    await db
      .select({ threadId: runs.chatThreadId, turnId: runs.chatTurnId })
      .from(runs)
      .where(
        and(
          eq(runs.runId, runId),
          eq(runs.userId, owner.userId),
          eq(runs.organizationId, owner.organizationId),
        ),
      )
      .limit(1)
  ).at(0);
  const threadId = run?.threadId ?? null;
  const turnId = run?.turnId ?? null;
  if (threadId === null || turnId === null || stepKeys.length === 0) {
    return 0;
  }
  // audit: skip - a turn's own bookkeeping: which of its steps have still to arrive
  const awaited = await db
    .insert(contents)
    .values(
      [...new Set(stepKeys)].map((stepKey) => ({
        threadId,
        stepKey,
        runId,
        turnId,
        outcome: AWAITED,
        totalBytes: 0,
        storedBytes: 0,
      })),
    )
    .onConflictDoNothing()
    .returning({ stepKey: contents.stepKey });
  return awaited.length;
};

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
  /** The step's run is over and announced it still had to send the step. */
  | { type: "awaited"; since: Date }
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
  | Exclude<VisibleStepContent, { type: "none" | "awaited" }>
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
          createdAt: contents.createdAt,
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
    row.outcome === null ||
    row.createdAt === null ||
    row.totalBytes === null ||
    row.storedBytes === null
  ) {
    return Result.ok({ type: row.sourceStores ? "not_copied" : "none" });
  }
  if (row.outcome === AWAITED) {
    return Result.ok({ type: "awaited", since: row.createdAt });
  }
  if (row.kind === null) {
    // The table's check gives every settled row its kind.
    return panic("A settled step content row holds no kind");
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
          // A step its run has still to send has nothing to copy yet.
          ne(contents.outcome, AWAITED),
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

/**
 * Whether a step awaited since `since` may still arrive at `now`: inside
 * its time a reader is told it is arriving, after it that nothing was stored.
 */
export const isStepStillAwaited = (since: Date, now: Date): boolean =>
  now.getTime() - since.getTime() <= CHAT_LOCAL_RUN_STEP_AWAITED_MS;
