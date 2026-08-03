import { Result } from "better-result";

import type { ChatThreadId } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";

type CreateDocumentDraftSaver = () => Promise<ArrayBuffer | null>;

type RetainedDraftSnapshot = {
  byteLength: number | null;
  captureId: object;
  promise: Promise<CreateDocumentDraftSaveResult>;
  restoration: Promise<CreateDocumentDraftSaveResult>;
};

type RetainedDraftChatBinding =
  | { status: "bound"; threadId: ChatThreadId }
  | { status: "unbound" };

let draftSavers: Record<string, CreateDocumentDraftSaver | undefined> = {};
let retainedDraftSnapshots: Record<string, RetainedDraftSnapshot | undefined> =
  {};
let retainedDraftChatBindings: Record<
  string,
  RetainedDraftChatBinding | undefined
> = {};
let savingDrafts: Readonly<Record<string, true | undefined>> = {};

const draftRuntimeKey = (toolCallId: string): string => `tool:${toolCallId}`;
const withoutRuntimeKey = <T>(
  values: Readonly<Record<string, T | undefined>>,
  key: string,
): Record<string, T | undefined> =>
  Object.fromEntries(
    Object.entries(values).filter(([candidate]) => candidate !== key),
  );

export type CreateDocumentDraftSaveResult =
  | { status: "failed"; error: unknown }
  | { status: "saved"; buffer: ArrayBuffer }
  | { status: "unavailable" };

export type PrepareCreateDocumentDraftResult =
  | { status: "failed"; error: unknown }
  | { status: "ready"; buffer: ArrayBuffer }
  | { status: "unavailable" };

type PrepareCreateDocumentDraftOptions = {
  compileFallback: () => Promise<ArrayBuffer | null>;
  toolCallId: string;
};

type SettleCreateDocumentDraftOptions = {
  isActive: () => boolean;
  settle: () => Promise<void>;
  wait: () => Promise<void>;
};

type RunCreateDocumentOperationOptions = {
  isActive: () => boolean;
  operation: () => Promise<void>;
  wait: () => Promise<void>;
};

export type RunCreateDocumentOperationResult =
  | { status: "cancelled" }
  | { status: "completed" }
  | { status: "failed"; error: unknown };

export type SettleCreateDocumentDraftResult =
  | { status: "cancelled" }
  | { status: "failed"; error: unknown }
  | { status: "settled" };

const CREATE_DOCUMENT_OPERATION_ATTEMPTS = 3;

export const runCreateDocumentOperationWithRetry = async ({
  isActive,
  operation,
  wait,
}: RunCreateDocumentOperationOptions): Promise<RunCreateDocumentOperationResult> => {
  const runAttempt = async (
    attempt: number,
  ): Promise<RunCreateDocumentOperationResult> => {
    if (!isActive()) {
      return { status: "cancelled" };
    }
    const result = await Result.tryPromise(operation);
    if (Result.isOk(result)) {
      return { status: "completed" };
    }
    if (attempt + 1 >= CREATE_DOCUMENT_OPERATION_ATTEMPTS) {
      return { status: "failed", error: result.error };
    }
    await wait();
    return await runAttempt(attempt + 1);
  };

  return await runAttempt(0);
};

export const settleCreateDocumentDraftWithRetry = async ({
  isActive,
  settle,
  wait,
}: SettleCreateDocumentDraftOptions): Promise<SettleCreateDocumentDraftResult> => {
  const result = await runCreateDocumentOperationWithRetry({
    isActive,
    operation: settle,
    wait,
  });
  switch (result.status) {
    case "cancelled":
      return result;
    case "completed":
      return { status: "settled" };
    case "failed":
      return result;
    default:
      return result satisfies never;
  }
};

const runDraftSaver = async (
  saver: CreateDocumentDraftSaver,
): Promise<CreateDocumentDraftSaveResult> => {
  const result = await Result.tryPromise(saver);
  if (Result.isError(result)) {
    return { status: "failed", error: result.error };
  }
  return result.value === null
    ? { status: "unavailable" }
    : { status: "saved", buffer: result.value };
};

const captureDraftSnapshot = async (
  toolCallId: string,
  saver: CreateDocumentDraftSaver,
): Promise<CreateDocumentDraftSaveResult> => {
  const key = draftRuntimeKey(toolCallId);
  const previous = retainedDraftSnapshots[key];
  const captureId = {};
  const saved = runDraftSaver(saver);
  const restoration = saved.then(async (result) => {
    if (result.status === "saved") {
      return result;
    }
    const previousRestoration = await previous?.restoration;
    // A failed capture is actionable state, not the absence of a snapshot.
    // Keep it until a later capture produces bytes; otherwise a remount could
    // fall back to model source and silently discard unsaved edits.
    return previousRestoration?.status === "unavailable"
      ? result
      : (previousRestoration ?? result);
  });
  const snapshot = (async () => {
    const result = await saved;
    const restorationResult = await restoration;
    const retained = retainedDraftSnapshots[key];
    if (retained?.captureId === captureId) {
      retainedDraftSnapshots = {
        ...retainedDraftSnapshots,
        [key]: {
          byteLength:
            restorationResult.status === "saved"
              ? restorationResult.buffer.byteLength
              : 0,
          captureId: retained.captureId,
          promise: retained.promise,
          restoration: retained.restoration,
        },
      };
    }
    return result;
  })();
  // A completed draft card stays actionable until the user resolves it. Its
  // local editor bytes are therefore durable runtime state, not an LRU cache:
  // evicting them would silently rebuild from the model source and lose edits.
  retainedDraftSnapshots = {
    ...retainedDraftSnapshots,
    [key]: {
      byteLength: previous?.byteLength ?? null,
      captureId,
      promise: snapshot,
      restoration,
    },
  };
  return await snapshot;
};

export const registerCreateDocumentDraftSaver = (
  toolCallId: string,
  saver: CreateDocumentDraftSaver,
): (() => void) => {
  const key = draftRuntimeKey(toolCallId);
  draftSavers = { ...draftSavers, [key]: saver };
  return () => {
    if (draftSavers[key] === saver) {
      draftSavers = withoutRuntimeKey(draftSavers, key);
      detached(
        captureDraftSnapshot(toolCallId, saver),
        "createDocumentDraftRuntime.captureUnmountedSnapshot",
      );
    }
  };
};

export const saveCreateDocumentDraft = async (
  toolCallId: string,
): Promise<CreateDocumentDraftSaveResult> => {
  const key = draftRuntimeKey(toolCallId);
  const saver = draftSavers[key];
  if (saver !== undefined) {
    const result = await captureDraftSnapshot(toolCallId, saver);
    if (result.status !== "unavailable") {
      return result;
    }
  }
  const retained = retainedDraftSnapshots[key];
  if (retained === undefined) {
    return { status: "unavailable" };
  }
  const result = await retained.promise;
  if (result.status !== "unavailable") {
    return result;
  }
  const restoration = await retained.restoration;
  return restoration.status === "unavailable" ? result : restoration;
};

export const prepareCreateDocumentDraft = async ({
  compileFallback,
  toolCallId,
}: PrepareCreateDocumentDraftOptions): Promise<PrepareCreateDocumentDraftResult> => {
  const saved = await saveCreateDocumentDraft(toolCallId);
  switch (saved.status) {
    case "failed":
      return saved;
    case "saved":
      return { status: "ready", buffer: saved.buffer };
    case "unavailable": {
      const fallback = await compileFallback();
      return fallback === null
        ? { status: "unavailable" }
        : { status: "ready", buffer: fallback };
    }
    default:
      return saved satisfies never;
  }
};

export const getCreateDocumentDraftRestoration = (
  toolCallId: string,
): Promise<CreateDocumentDraftSaveResult> | null =>
  retainedDraftSnapshots[draftRuntimeKey(toolCallId)]?.restoration ?? null;

export const bindCreateDocumentDraftChatThread = ({
  chatThreadId,
  toolCallId,
}: {
  chatThreadId: ChatThreadId;
  toolCallId: string;
}): void => {
  retainedDraftChatBindings = {
    ...retainedDraftChatBindings,
    [draftRuntimeKey(toolCallId)]: {
      status: "bound",
      threadId: chatThreadId,
    },
  };
};

export const clearCreateDocumentDraftChatThreadBinding = (
  toolCallId: string,
): void => {
  const key = draftRuntimeKey(toolCallId);
  if (retainedDraftChatBindings[key]?.status !== "bound") {
    return;
  }
  retainedDraftChatBindings = {
    ...retainedDraftChatBindings,
    [key]: { status: "unbound" },
  };
};

export const getBoundCreateDocumentDraftChatThreadId = (
  toolCallId: string,
): ChatThreadId | null => {
  const binding = retainedDraftChatBindings[draftRuntimeKey(toolCallId)];
  return binding?.status === "bound" ? binding.threadId : null;
};

/**
 * A draft save has no mounted-editor prerequisite: the action card may remain
 * visible after its inspector tab closes. Keep the write lock with the draft
 * runtime itself so reopening during the upload is necessarily read-only.
 */
export const beginCreateDocumentDraftPersistence = (
  toolCallId: string,
): boolean => {
  const key = draftRuntimeKey(toolCallId);
  if (savingDrafts[key] === true) {
    return false;
  }
  savingDrafts = { ...savingDrafts, [key]: true };
  return true;
};

export const isCreateDocumentDraftPersistenceActive = (
  toolCallId: string,
): boolean => savingDrafts[draftRuntimeKey(toolCallId)] === true;

export const endCreateDocumentDraftPersistence = (toolCallId: string): void => {
  const key = draftRuntimeKey(toolCallId);
  if (savingDrafts[key] !== true) {
    return;
  }
  savingDrafts = withoutRuntimeKey(savingDrafts, key);
};

export const completeCreateDocumentDraft = (toolCallId: string): void => {
  const key = draftRuntimeKey(toolCallId);
  draftSavers = withoutRuntimeKey(draftSavers, key);
  retainedDraftSnapshots = withoutRuntimeKey(retainedDraftSnapshots, key);
  retainedDraftChatBindings = withoutRuntimeKey(retainedDraftChatBindings, key);
  endCreateDocumentDraftPersistence(toolCallId);
};

export const __resetCreateDocumentDraftRuntimeForTests = (): void => {
  draftSavers = {};
  retainedDraftSnapshots = {};
  retainedDraftChatBindings = {};
  savingDrafts = {};
};
