import { Result } from "better-result";

import { detached } from "@/lib/detached";

type CreateDocumentDraftSaver = () => Promise<ArrayBuffer | null>;

const MAX_RETAINED_DRAFT_SNAPSHOTS = 32;
const MAX_RETAINED_DRAFT_SNAPSHOT_BYTES = 64 * 1024 * 1024;

type RetainedDraftSnapshot = {
  byteLength: number | null;
  promise: Promise<CreateDocumentDraftSaveResult>;
};

let draftSavers: Record<string, CreateDocumentDraftSaver | undefined> = {};
let retainedDraftSnapshots: Record<string, RetainedDraftSnapshot | undefined> =
  {};

const draftRuntimeKey = (toolCallId: string): string => `tool:${toolCallId}`;
const withoutRuntimeKey = <T>(
  values: Readonly<Record<string, T | undefined>>,
  key: string,
): Record<string, T | undefined> =>
  Object.fromEntries(
    Object.entries(values).filter(([candidate]) => candidate !== key),
  );

const withRetainedDraftSnapshot = (
  values: Readonly<Record<string, RetainedDraftSnapshot | undefined>>,
  key: string,
  snapshot: RetainedDraftSnapshot,
): Record<string, RetainedDraftSnapshot | undefined> => {
  const entries = Object.entries(withoutRuntimeKey(values, key));
  entries.push([key, snapshot]);
  return Object.fromEntries(entries.slice(-MAX_RETAINED_DRAFT_SNAPSHOTS));
};

const pruneRetainedDraftSnapshotsByBytes = (): void => {
  const entries = Object.entries(retainedDraftSnapshots);
  const retained: [string, RetainedDraftSnapshot][] = [];
  let retainedBytes = 0;
  for (const [key, snapshot] of entries.toReversed()) {
    if (snapshot === undefined) {
      continue;
    }
    const byteLength = snapshot.byteLength ?? 0;
    if (
      byteLength > 0 &&
      retainedBytes + byteLength > MAX_RETAINED_DRAFT_SNAPSHOT_BYTES
    ) {
      continue;
    }
    retainedBytes += byteLength;
    retained.push([key, snapshot]);
  }
  retainedDraftSnapshots = Object.fromEntries(retained.toReversed());
};

export type CreateDocumentDraftSaveResult =
  | { status: "failed"; error: unknown }
  | { status: "saved"; buffer: ArrayBuffer }
  | { status: "unavailable" };

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
  const snapshot = runDraftSaver(saver);
  retainedDraftSnapshots = withRetainedDraftSnapshot(
    retainedDraftSnapshots,
    draftRuntimeKey(toolCallId),
    { byteLength: null, promise: snapshot },
  );
  const result = await snapshot;
  const key = draftRuntimeKey(toolCallId);
  const retained = retainedDraftSnapshots[key];
  if (retained?.promise === snapshot) {
    retainedDraftSnapshots = {
      ...retainedDraftSnapshots,
      [key]: {
        byteLength: result.status === "saved" ? result.buffer.byteLength : 0,
        promise: snapshot,
      },
    };
    pruneRetainedDraftSnapshotsByBytes();
  }
  return result;
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
    return await captureDraftSnapshot(toolCallId, saver);
  }
  return (
    (await retainedDraftSnapshots[key]?.promise) ?? {
      status: "unavailable",
    }
  );
};

export const clearCreateDocumentDraftSnapshot = (toolCallId: string): void => {
  retainedDraftSnapshots = withoutRuntimeKey(
    retainedDraftSnapshots,
    draftRuntimeKey(toolCallId),
  );
};

export const __resetCreateDocumentDraftRuntimeForTests = (): void => {
  draftSavers = {};
  retainedDraftSnapshots = {};
};
