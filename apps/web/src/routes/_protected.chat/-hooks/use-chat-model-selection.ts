import { useRef } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { ClientOperationError, toAPIError } from "@/lib/errors";
import type { APIError } from "@/lib/errors";
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
  onPersisted: (model: string | null) => void;
};

export type ChatModelSelection = {
  /** Persist the chosen model. Fire from the (+) menu's radio item;
   *  fire-and-forget is fine there since `awaitPendingSelection` is what
   *  gates the send path. Already toasts on failure (unless a newer
   *  selection has since superseded this one). */
  selectModel: (model: string | null) => void;
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
  const pendingRef = useRef<Promise<Result<void, ModelPersistError>> | null>(
    null,
  );

  const persist = async (
    model: string | null,
  ): Promise<Result<void, ModelPersistError>> => {
    const requestId = ++requestIdRef.current;
    const result = await Result.tryPromise(
      async () =>
        await api.chat
          .threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) })
          .model.patch(
            { model },
            {
              query:
                threadRef.scope === "workspace"
                  ? {
                      workspaceId: toSafeId<"workspace">(threadRef.workspaceId),
                    }
                  : {},
              fetch: { signal: AbortSignal.timeout(MODEL_SELECT_TIMEOUT_MS) },
            },
          ),
    );
    // A stale response (a newer selection has already been issued): never
    // toast for it and never touch the cache -- the newer request owns
    // both once it settles.
    const isLatest = requestId === requestIdRef.current;

    if (Result.isError(result)) {
      if (isLatest) {
        stellaToast.add({
          title: t("common.somethingWentWrong"),
          type: "error",
        });
      }
      return Result.err(
        new ClientOperationError({
          action: "chat.selectModel",
          cause: result.error,
          message: "Failed to persist the selected model",
        }),
      );
    }
    if (result.value.error) {
      const error = toAPIError(result.value.error);
      if (isLatest) {
        stellaToast.add({
          title: t("common.somethingWentWrong"),
          type: "error",
        });
      }
      return Result.err(error);
    }
    if (isLatest) {
      onPersisted(model);
    }
    return Result.ok(undefined);
  };

  const selectModel = (model: string | null) => {
    const promise = persist(model);
    pendingRef.current = promise;
    void promise.finally(() => {
      if (pendingRef.current === promise) {
        pendingRef.current = null;
      }
    });
  };

  const awaitPendingSelection = async (): Promise<
    Result<void, ModelPersistError>
  > => {
    const pending = pendingRef.current;
    if (!pending) {
      return Result.ok(undefined);
    }
    return await pending;
  };

  return { awaitPendingSelection, selectModel };
};
