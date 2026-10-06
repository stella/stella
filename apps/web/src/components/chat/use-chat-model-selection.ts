import { useRef } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import type { ReasoningEffort } from "@stll/ai-catalog";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { api } from "@/lib/api";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { getChatThreadKey } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { type APIError, toAPIError } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";

/** Client-observed ceiling for a model-selection PATCH: long enough for a
 *  slow network, short enough that a hung request can't indefinitely block
 *  message submit (see `awaitPendingSelection`). */
const MODEL_SELECT_TIMEOUT_MS = 10_000;

type ModelPersistError = APIError | ClientOperationError;

export type UseChatModelSelectionOptions = {
  threadRef: ChatThreadRef;
  /** Applies a *persisted* model to the caller's own cache (see
   *  `applyChatModelChange`). Only invoked when the settling request is
   *  still the latest one issued -- a slower, stale response can never
   *  revert a newer selection (the `requestIdRef` guard below). */
  onPersisted: (selection: PersistedChatModelSelection) => void;
  /** A carried draft selection must reach the server before its first send. */
  draftSelection?:
    | (PersistedChatModelSelection & {
        threadExists: boolean;
        modelSelectionSource?: "carried" | undefined;
      })
    | undefined;
};

export type PersistedChatModelSelection = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
};

type PersistChatModelSelectionArgs = {
  threadRef: ChatThreadRef;
  selection: PersistedChatModelSelection;
};

export const persistChatModelSelection = async ({
  threadRef,
  selection,
}: PersistChatModelSelectionArgs): Promise<Result<void, ModelPersistError>> => {
  const result = await Result.tryPromise(async () => {
    const response = await api.chat
      .threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) })
      .model.patch(selection, {
        query:
          threadRef.scope === "workspace"
            ? { workspaceId: toSafeId<"workspace">(threadRef.workspaceId) }
            : {},
        fetch: { signal: AbortSignal.timeout(MODEL_SELECT_TIMEOUT_MS) },
      });
    if (response.error) {
      return Result.err(toAPIError(response.error));
    }
    return Result.ok(undefined);
  });
  if (Result.isError(result)) {
    return Result.err(
      new ClientOperationError({
        action: "chat.selectModel",
        cause: result.error,
        message: "Failed to persist the selected model",
      }),
    );
  }
  return result.value;
};

export type ChatModelSelection = {
  /** Persist the chosen model. Fire from the (+) menu's radio item;
   *  fire-and-forget is fine there since `awaitPendingSelection` is what
   *  gates the send path. Already toasts on failure (unless a newer
   *  selection has since superseded this one). */
  selectModel: (selection: PersistedChatModelSelection) => void;
  /** Resolves once the most recently issued `selectModel` call has
   *  settled, or immediately if none is in flight. An error result means
   *  the PATCH failed or timed out and has already been toasted -- the
   *  caller should abort the send rather than proceed with a model that
   *  may not match what the server has persisted. */
  awaitPendingSelection: () => Promise<Result<void, ModelPersistError>>;
};

/**
 * Drives the composer (+) menu's Models submenu: persists a per-thread
 * model override and keeps a monotonic guard so rapid reselection can
 * never have a slower, stale response overwrite a faster, later one --
 * neither in the visible radio selection nor in the query cache. Message
 * submit awaits `awaitPendingSelection` before building its request so a
 * just-changed model can never race the send. One hook shared by every
 * composer surface with a Models submenu (the draft `/chat` composer and
 * `ChatThreadPage`) instead of three parallel fixes.
 */
export const useChatModelSelection = ({
  threadRef,
  onPersisted,
  draftSelection,
}: UseChatModelSelectionOptions): ChatModelSelection => {
  const t = useTranslations();
  // Bumped on every `selectModel` call; a settling request only applies
  // its outcome (cache update on success, toast on failure) when its own
  // id still matches -- a guard against an older, slower response landing
  // after a newer one already resolved.
  const requestIdRef = useRef(0);
  // The latest in-flight persistence promise, or null once idle. Read by
  // `awaitPendingSelection` so message submit blocks on exactly the
  // selection the user actually made last, not the whole submenu's
  // history.
  const pendingRef = useRef<{
    threadKey: string;
    promise: Promise<Result<void, ModelPersistError>>;
  } | null>(null);
  const carriedDraftRef = useRef<{
    threadKey: string;
    promise: Promise<Result<void, ModelPersistError>>;
  } | null>(null);
  const threadKey = getChatThreadKey(threadRef);
  const getCurrentThreadKey = useLatestCallback(() => threadKey);

  const persist = async (
    selection: PersistedChatModelSelection,
  ): Promise<Result<void, ModelPersistError>> => {
    const requestId = ++requestIdRef.current;
    const result = await persistChatModelSelection({ threadRef, selection });
    // A stale response (a newer selection has already been issued): never
    // toast for it and never touch the cache -- the newer request owns
    // both once it settles.
    const isLatest =
      requestId === requestIdRef.current && getCurrentThreadKey() === threadKey;

    if (Result.isError(result)) {
      if (isLatest) {
        notifyUserError(result.error, t("common.somethingWentWrong"));
      }
      return result;
    }
    if (isLatest) {
      onPersisted(selection);
    }
    return Result.ok(undefined);
  };

  const selectModel = (selection: PersistedChatModelSelection) => {
    const promise = persist(selection);
    pendingRef.current = { threadKey, promise };
    if (carriedDraftRef.current?.threadKey === threadKey) {
      carriedDraftRef.current = { threadKey, promise };
    }
    detached(
      promise.finally(() => {
        if (pendingRef.current?.promise === promise) {
          pendingRef.current = null;
        }
      }),
      "use-chat-model-selection.persist-selection",
    );
  };

  type CarriedSelection = Promise<Result<void, ModelPersistError>> | null;
  const ensureCarriedSelection = useLatestCallback((): CarriedSelection => {
    if (
      draftSelection === undefined ||
      (draftSelection.threadExists &&
        draftSelection.modelSelectionSource !== "carried") ||
      (draftSelection.model === null && draftSelection.reasoningEffort === null)
    ) {
      return null;
    }
    if (carriedDraftRef.current?.threadKey === threadKey) {
      return carriedDraftRef.current.promise;
    }
    const promise = persist({
      model: draftSelection.model,
      reasoningEffort: draftSelection.reasoningEffort,
    });
    carriedDraftRef.current = { threadKey, promise };
    pendingRef.current = { threadKey, promise };
    return promise;
  });

  useExternalSyncEffect(() => {
    const pending = ensureCarriedSelection();
    if (pending !== null) {
      detached(pending, "use-chat-model-selection.persist-carried-draft");
    }
  }, [
    draftSelection?.model,
    draftSelection?.modelSelectionSource,
    draftSelection?.reasoningEffort,
    draftSelection?.threadExists,
    ensureCarriedSelection,
    threadKey,
  ]);

  const awaitPendingSelection = async (): Promise<
    Result<void, ModelPersistError>
  > => {
    const carried = ensureCarriedSelection();
    const pending =
      pendingRef.current?.threadKey === threadKey
        ? pendingRef.current.promise
        : carried;
    if (!pending) {
      return Result.ok(undefined);
    }
    return await pending;
  };

  return { awaitPendingSelection, selectModel };
};
