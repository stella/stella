/**
 * useEditSession — manages the lifecycle of a browser DOCX editing session.
 *
 * Wraps the existing desktop-edit-session API endpoints:
 * open (acquire lock + presigned URL) → checkpoint (auto-save) → finalize / cancel.
 */

import { useCallback, useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { panic, Result, TaggedError } from "better-result";
import { useDebouncedCallback } from "use-debounce";

import { useLatest } from "@stll/ui/use-latest";

import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { DOCX_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { fetchWithTimeout } from "@/lib/fetch";
import { filesKeys } from "@/lib/files/queries";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

import { selectStableArrayBuffer } from "./array-buffer-utils";
import { resolveEditSessionExit } from "./docx-edit-mode.logic";

export type EditSessionState =
  | { status: "idle" }
  | { status: "opening" }
  | {
      status: "editing";
      sessionId: string;
      sessionToken: string;
      buffer: ArrayBuffer;
      fileName: string;
    }
  | { status: "saving" }
  | {
      status: "error";
      reason: EditSessionErrorReason;
      source: EditSessionErrorSource;
      detail?: string | undefined;
    };

export type EditSessionErrorReason =
  | "authRequired"
  | "permissionDenied"
  | "downloadFailed"
  | "takenOver"
  | "unknown";

type EditSessionErrorSource = "open" | "download" | "checkpoint" | "finalize";

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
// A keepalive request outlives the page; the timeout only bounds the
// promise the unload handler is not waiting on anyway.
const UNLOAD_FINALIZE_TIMEOUT_MS = 30_000;

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

type InvalidateFinalizedEditSessionOptions = {
  fieldId: string;
  /** The field the new version landed on; equals `fieldId` when nothing was written. */
  finalizedFieldId: string;
  queryClient: QueryClient;
  workspaceId: string;
};

const invalidateFinalizedEditSessionQueries = async ({
  fieldId,
  finalizedFieldId,
  queryClient,
  workspaceId,
}: InvalidateFinalizedEditSessionOptions) => {
  const fieldIds =
    finalizedFieldId === fieldId ? [fieldId] : [fieldId, finalizedFieldId];
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(workspaceId),
    }),
    ...fieldIds.flatMap((id) => [
      queryClient.invalidateQueries({
        queryKey: filesKeys.byFieldId({
          workspaceId,
          fieldId: id,
          purpose: "native-display",
        }),
      }),
      queryClient.invalidateQueries({
        queryKey: filesKeys.metadataByFieldId({
          workspaceId,
          fieldId: id,
          purpose: "native-display",
        }),
      }),
    ]),
  ]);
};

type EditSessionHandle = {
  sessionId: string;
  sessionToken: string;
};

type FinalizeAbandonedEditSessionOptions = EditSessionHandle & {
  fieldId: string;
  queryClient: QueryClient;
  workspaceId: string;
};

/**
 * Unmount fallback for an editor that went away without an explicit
 * leave. The server turns the session's last checkpoint into a
 * version and writes nothing when that checkpoint matches the base,
 * so this cannot mint an empty version.
 */
const finalizeAbandonedEditSession = async ({
  fieldId,
  queryClient,
  sessionId,
  sessionToken,
  workspaceId,
}: FinalizeAbandonedEditSessionOptions) => {
  const response = await api["desktop-edit-sessions"]({
    sessionId,
  }).finalize.post({ sessionToken });

  if (response.error) {
    getAnalytics().captureError(toAPIError(response.error));
    return;
  }

  await invalidateFinalizedEditSessionQueries({
    fieldId,
    finalizedFieldId:
      response.data.outcome === "finalized" ? response.data.fieldId : fieldId,
    queryClient,
    workspaceId,
  });
};

/**
 * Tab-close path. The Eden client cannot set `keepalive`, and a
 * normal fetch is cancelled the moment the document unloads, so the
 * finalize POST is issued directly here.
 */
const finalizeEditSessionOnUnload = async ({
  sessionId,
  sessionToken,
}: EditSessionHandle) => {
  await fetchWithTimeout(
    apiUrl(`/desktop-edit-sessions/${sessionId}/finalize`),
    {
      body: JSON.stringify({ sessionToken }),
      credentials: "include",
      headers: { "content-type": "application/json" },
      keepalive: true,
      method: "POST",
      timeoutMs: UNLOAD_FINALIZE_TIMEOUT_MS,
    },
  );
};

const getEditSessionErrorReason = (error: {
  status: number;
}): EditSessionErrorReason => {
  if (error.status === 401) {
    return "authRequired";
  }

  if (error.status === 403) {
    return "permissionDenied";
  }

  if (error.status === 409) {
    return "takenOver";
  }

  return "unknown";
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
  const sessionContextRef = useLatest({
    workspaceId,
    entityId,
    fieldId,
    propertyId,
  });
  // Whether this session has produced anything worth versioning. Set
  // the moment the document is marked dirty, so an edit inside the
  // checkpoint debounce window still finalizes; cleared only when the
  // session ends.
  const hasCheckpointedChangesRef = useRef(false);
  const isMountedRef = useRef(true);
  const isMounted = () => isMountedRef.current;

  // Only the edits that have not reached the server yet would be lost
  // on a tab close; anything already checkpointed is finalized by the
  // pagehide handler below.
  useExternalSyncEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  useMountEffect(() => {
    const handler = () => {
      const session = sessionRef.current;
      if (!session) {
        return;
      }
      const exit = resolveEditSessionExit({
        hasCheckpointedChanges: hasCheckpointedChangesRef.current,
      });
      switch (exit.action) {
        case "finalize": {
          detached(
            finalizeEditSessionOnUnload(session),
            "use-edit-session.finalize-on-unload",
          );
          return;
        }
        case "release": {
          // The lock expires on its own; an unload has no time to
          // wait for a release round-trip.
          return;
        }
        default: {
          exit satisfies never;
          panic(`Unhandled edit-session exit: ${String(exit)}`);
        }
      }
    };
    window.addEventListener("pagehide", handler);
    return () => window.removeEventListener("pagehide", handler);
  });

  const open = async (force?: boolean) => {
    const releaseContext: EditSessionReleaseContext = {
      workspaceId,
      entityId,
      propertyId,
    };
    hasCheckpointedChangesRef.current = false;
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
      setState({
        detail: userErrorMessage(response.error, "Failed to open DOCX."),
        status: "error",
        reason: getEditSessionErrorReason(response.error),
        source: "open",
      });
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

  const saveCheckpointNow = async (docxBuffer: ArrayBuffer) => {
    const session = sessionRef.current;
    if (!session) {
      return false;
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
      if (response.error.status === 409) {
        sessionRef.current = null;
        hasCheckpointedChangesRef.current = false;
        setIsDirty(false);
        setState({
          status: "error",
          reason: "takenOver",
          source: "checkpoint",
          detail: userErrorMessage(response.error, "Failed to save DOCX."),
        });
      }
      return false;
    }

    if (response.data.rotatedSessionToken) {
      sessionRef.current = {
        fileName: session.fileName,
        sessionId: session.sessionId,
        sessionToken: response.data.rotatedSessionToken,
      };
    }
    hasCheckpointedChangesRef.current = true;
    setIsDirty(false);
    return true;
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
      const context = sessionContextRef.current;
      const exit = resolveEditSessionExit({
        hasCheckpointedChanges: hasCheckpointedChangesRef.current,
      });
      hasCheckpointedChangesRef.current = false;

      switch (exit.action) {
        case "finalize": {
          // The editor vanished without going through `leave` (a
          // remount, an error boundary). The session still owes the
          // user their one version.
          detached(
            finalizeAbandonedEditSession({
              fieldId: context.fieldId,
              queryClient,
              sessionId: session.sessionId,
              sessionToken: session.sessionToken,
              workspaceId: context.workspaceId,
            }),
            "use-edit-session.finalize-abandoned-session",
          );
          return;
        }
        case "release": {
          detached(
            releaseEditSession(context),
            "use-edit-session.release-edit-session",
          );
          return;
        }
        default: {
          exit satisfies never;
          panic(`Unhandled edit-session exit: ${String(exit)}`);
        }
      }
    };
  });

  const markDirtyAndCheckpoint = (buffer: ArrayBuffer) => {
    hasCheckpointedChangesRef.current = true;
    setIsDirty(true);
    debouncedCheckpoint(buffer);
  };

  const markDirty = useCallback(() => {
    hasCheckpointedChangesRef.current = true;
    setIsDirty(true);
  }, []);

  const finalize = async () => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }

    debouncedCheckpoint.cancel();

    setState({ status: "saving" });

    const response = await api["desktop-edit-sessions"]({
      sessionId: session.sessionId,
    }).finalize.post({
      sessionToken: session.sessionToken,
    });

    sessionRef.current = null;
    hasCheckpointedChangesRef.current = false;
    setIsDirty(false);

    if (response.error) {
      setState({
        detail: userErrorMessage(response.error, "Failed to save DOCX."),
        status: "error",
        reason: getEditSessionErrorReason(response.error),
        source: "finalize",
      });
      return;
    }

    await invalidateFinalizedEditSessionQueries({
      fieldId,
      finalizedFieldId:
        response.data.outcome === "finalized" ? response.data.fieldId : fieldId,
      queryClient,
      workspaceId,
    });

    setState({ status: "idle" });
    onFinalized?.(response.data);
  };

  const cancel = async () => {
    const session = sessionRef.current;
    if (!session) {
      setState({ status: "idle" });
      onCancelled?.();
      return;
    }

    debouncedCheckpoint.cancel();

    const context = sessionContextRef.current;
    const released = await releaseEditSession(context);
    if (!released) {
      throw new EditSessionReleaseError({
        message: "The desktop edit session could not be released.",
      });
    }

    sessionRef.current = null;
    hasCheckpointedChangesRef.current = false;
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
