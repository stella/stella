/**
 * useEditSession — manages the lifecycle of a browser DOCX editing session.
 *
 * Wraps the existing desktop-edit-session API endpoints:
 * open (acquire lock + presigned URL) → checkpoint (auto-save) → finalize / cancel.
 */

import { useCallback, useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result, TaggedError } from "better-result";
import { useDebouncedCallback } from "use-debounce";

import { fetchWithTimeout } from "@stll/fetch";
import { useLatest } from "@stll/ui/use-latest";

import { useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useUnsavedWork } from "@/hooks/use-unsaved-work";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { DOCX_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { selectStableArrayBuffer } from "@/lib/files/array-buffer-utils";
import { filesKeys } from "@/lib/files/queries";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

import {
  resolveEditSessionFailure,
  resolveTakenOverSession,
} from "./use-edit-session.logic";
import type { EditSessionState } from "./use-edit-session.logic";

type FinalizeEditSessionResult =
  | {
      outcome: "finalized";
      entityId: string;
      fieldId: string;
      versionId: string;
      versionNumber: number;
    }
  | { outcome: "no_changes" };

type UseEditSessionOptions = {
  workspaceId: string;
  entityId: string;
  fieldId: string;
  propertyId: string;
  /** Already-rendered preview buffer, reused when the edit download matches it. */
  initialBuffer?: ArrayBuffer | undefined;
  /** Called after finalize succeeds (new version created). */
  onFinalized?: (result: FinalizeEditSessionResult) => void;
  /** Called after cancel/discard. */
  onCancelled?: () => void;
};

const CHECKPOINT_DEBOUNCE_MS = 5000;

/**
 * What a checkpoint did with the bytes it was handed. `released` is not a
 * failure to report: the lock moved to another tab mid-save, and the released
 * session already tells the user so.
 */
type CheckpointOutcome = "failed" | "released" | "saved";

type EditSessionReleaseContext = {
  workspaceId: string;
  entityId: string;
  propertyId: string;
};

class EditSessionReleaseError extends TaggedError("EditSessionReleaseError")<{
  message: string;
}> {}

const releaseEditSession = async ({
  workspaceId,
  entityId,
  propertyId,
}: EditSessionReleaseContext) => {
  const result = await Result.tryPromise(async () => {
    const response = await api
      .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["desktop-edit-sessions"].release.post({
        entityId: toSafeId<"entity">(entityId),
        propertyId: toSafeId<"property">(propertyId),
      });
    if (response.error) {
      return { status: "error" as const, error: toAPIError(response.error) };
    }
    return { status: "released" as const };
  });

  if (Result.isError(result)) {
    getAnalytics().captureError(result.error);
    return false;
  }
  if (result.value.status === "error") {
    getAnalytics().captureError(result.value.error);
    return false;
  }
  return true;
};

export const useEditSession = ({
  workspaceId,
  entityId,
  fieldId,
  propertyId,
  initialBuffer,
  onFinalized,
  onCancelled,
}: UseEditSessionOptions) => {
  const queryClient = useQueryClient();
  const [state, setState] = useState<EditSessionState>({ status: "idle" });
  const [isDirty, setIsDirty] = useState(false);
  const sessionRef = useRef<{
    fileName: string;
    sessionId: string;
    sessionToken: string;
  } | null>(null);
  const checkpointQueueRef = useRef<Promise<void> | null>(null);
  checkpointQueueRef.current ??= Promise.resolve();
  const releaseContextRef = useLatest({ workspaceId, entityId, propertyId });
  const isMountedRef = useRef(true);
  const isMounted = () => isMountedRef.current;

  useUnsavedWork({ surface: "docx-edit-session", guard: "unload", isDirty });

  const open = async (force?: boolean) => {
    const releaseContext: EditSessionReleaseContext = {
      workspaceId,
      entityId,
      propertyId,
    };
    setState({ status: "opening" });

    const response = await api
      .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["desktop-edit-sessions"].open.post({
        entityId: toSafeId<"entity">(entityId),
        propertyId: toSafeId<"property">(propertyId),
        ...(force && { force }),
      });

    if (response.error) {
      if (!isMounted()) {
        return false;
      }
      setState(
        resolveEditSessionFailure({
          detail: userErrorMessage(response.error, "Failed to open DOCX."),
          hasUnsavedChanges: isDirty,
          source: "open",
          status: response.error.status,
        }),
      );
      return false;
    }

    const { sessionId, sessionToken, downloadUrl, fileName } = response.data;
    sessionRef.current = { fileName, sessionId, sessionToken };
    if (!isMounted()) {
      sessionRef.current = null;
      await releaseEditSession(releaseContext);
      return false;
    }

    const fileResponse = await fetchWithTimeout(downloadUrl, {
      timeoutMs: 30_000,
    }).catch((error: unknown) => {
      getAnalytics().captureError(error);
      return null;
    });
    if (!fileResponse?.ok) {
      sessionRef.current = null;
      await releaseEditSession(releaseContext);
      if (!isMounted()) {
        return false;
      }
      setState({
        status: "error",
        reason: "downloadFailed",
        source: "download",
      });
      return false;
    }

    if (!isMounted()) {
      sessionRef.current = null;
      await releaseEditSession(releaseContext);
      return false;
    }

    const downloadedBuffer = await fileResponse.arrayBuffer();
    if (!isMounted()) {
      sessionRef.current = null;
      await releaseEditSession(releaseContext);
      return false;
    }

    setState({
      status: "editing",
      sessionId,
      sessionToken,
      buffer: selectStableArrayBuffer({
        incomingBuffer: downloadedBuffer,
        stableBuffer: initialBuffer,
      }),
      fileName,
    });
    await queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(workspaceId),
    });
    return true;
  };

  const saveCheckpointNow = async (
    docxBuffer: ArrayBuffer,
  ): Promise<CheckpointOutcome> => {
    const session = sessionRef.current;
    if (!session) {
      return "failed";
    }

    const file = new File([docxBuffer], session.fileName, {
      type: DOCX_MIME,
    });

    const response = await api["desktop-edit-sessions"]({
      sessionId: session.sessionId,
    }).checkpoint.post({
      file,
      sessionToken: session.sessionToken,
    });

    if (response.error) {
      // The checkpoint that lost the race holds the only copy of the user's
      // latest work, so the released state says the changes are unsaved. Any
      // other checkpoint failure is transient and the autosave status reports
      // it without ending the session.
      const takenOver = resolveTakenOverSession({
        hasUnsavedChanges: true,
        status: response.error.status,
      });
      if (takenOver === null) {
        return "failed";
      }

      sessionRef.current = null;
      setIsDirty(false);
      setState(takenOver);
      return "released";
    }

    if (response.data.rotatedSessionToken) {
      sessionRef.current = {
        fileName: session.fileName,
        sessionId: session.sessionId,
        sessionToken: response.data.rotatedSessionToken,
      };
    }
    setIsDirty(false);
    return "saved";
  };

  const saveCheckpoint = async (docxBuffer: ArrayBuffer) => {
    const queue = checkpointQueueRef.current ?? Promise.resolve();
    const checkpoint = queue.then(
      async () => await saveCheckpointNow(docxBuffer),
    );
    checkpointQueueRef.current = checkpoint.then(
      () => undefined,
      () => undefined,
    );
    return await checkpoint;
  };

  const debouncedCheckpoint = useDebouncedCallback((buffer: ArrayBuffer) => {
    detached(saveCheckpoint(buffer), "use-edit-session.save-checkpoint");
  }, CHECKPOINT_DEBOUNCE_MS);
  const cancelDebouncedCheckpoint = useLatestCallback(() => {
    debouncedCheckpoint.cancel();
  });

  useMountEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cancelDebouncedCheckpoint();
      const session = sessionRef.current;
      if (!session) {
        return;
      }

      sessionRef.current = null;
      const context = releaseContextRef.current;
      detached(
        releaseEditSession(context),
        "use-edit-session.release-edit-session",
      );
    };
  });

  const markDirtyAndCheckpoint = (buffer: ArrayBuffer) => {
    setIsDirty(true);
    debouncedCheckpoint(buffer);
  };

  const markDirty = useCallback(() => {
    setIsDirty(true);
  }, []);

  const finalize = async () => {
    debouncedCheckpoint.cancel();
    // A checkpoint still in flight rotates the session token when it lands;
    // a finalize sent beside it would carry the old token and be refused as
    // a take-over. Join the checkpoint queue, then read the session.
    await (checkpointQueueRef.current ?? Promise.resolve());
    const session = sessionRef.current;
    if (!session) {
      return true;
    }

    setState({ status: "saving" });

    const response = await api["desktop-edit-sessions"]({
      sessionId: session.sessionId,
    }).finalize.post({
      sessionToken: session.sessionToken,
    });

    if (response.error) {
      const failure = resolveEditSessionFailure({
        detail: userErrorMessage(response.error, "Failed to save DOCX."),
        hasUnsavedChanges: isDirty,
        source: "finalize",
        status: response.error.status,
      });
      // A released session is gone server-side: keeping the local handle would
      // let unmount cleanup release whatever session replaced it, and keeping
      // the dirty flag would leave the unload warning armed.
      if (failure.status === "released") {
        sessionRef.current = null;
        setIsDirty(false);
      }
      setState(failure);
      return false;
    }

    sessionRef.current = null;
    setIsDirty(false);

    const finalizedFieldId =
      response.data.outcome === "finalized" ? response.data.fieldId : fieldId;
    await Promise.all(
      [
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: filesKeys.byFieldId({
            workspaceId,
            fieldId,
            purpose: "native-display",
          }),
        }),
        queryClient.invalidateQueries({
          queryKey: filesKeys.metadataByFieldId({
            workspaceId,
            fieldId,
            purpose: "native-display",
          }),
        }),
        finalizedFieldId !== fieldId
          ? queryClient.invalidateQueries({
              queryKey: filesKeys.byFieldId({
                workspaceId,
                fieldId: finalizedFieldId,
                purpose: "native-display",
              }),
            })
          : null,
        finalizedFieldId !== fieldId
          ? queryClient.invalidateQueries({
              queryKey: filesKeys.metadataByFieldId({
                workspaceId,
                fieldId: finalizedFieldId,
                purpose: "native-display",
              }),
            })
          : null,
      ].filter((promise) => promise !== null),
    );

    setState({ status: "idle" });
    onFinalized?.(response.data);
    return true;
  };

  const cancel = async () => {
    const session = sessionRef.current;
    if (!session) {
      setState({ status: "idle" });
      onCancelled?.();
      return;
    }

    debouncedCheckpoint.cancel();

    const context = releaseContextRef.current;
    const released = await releaseEditSession(context);
    if (!released) {
      throw new EditSessionReleaseError({
        message: "The desktop edit session could not be released.",
      });
    }

    sessionRef.current = null;
    setIsDirty(false);
    setState({ status: "idle" });
    await queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(context.workspaceId),
    });
    onCancelled?.();
  };

  const resetError = () => {
    setState((current) => {
      if (current.status !== "error") {
        return current;
      }
      return { status: "idle" };
    });
  };

  return {
    state,
    /** Whether the current edit session has user-visible changes. */
    isDirty,
    /** Acquire lock and load the DOCX. */
    open,
    /** Mark the document dirty without serializing a checkpoint yet. */
    markDirty,
    /** Mark the document dirty and queue a debounced checkpoint (auto-save). */
    checkpoint: markDirtyAndCheckpoint,
    /** Save the current document immediately. */
    saveCheckpoint,
    /** Finalize: flush checkpoint, create new version, release lock. */
    finalize,
    /** Discard: cancel checkpoint, release lock, no new version. */
    cancel,
    /** Return to preview after a recoverable open/download failure. */
    resetError,
  };
};

export type EditSession = ReturnType<typeof useEditSession>;
