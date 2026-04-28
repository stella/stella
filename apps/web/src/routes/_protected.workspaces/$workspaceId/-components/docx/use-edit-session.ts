/**
 * useEditSession — manages the lifecycle of a browser DOCX editing session.
 *
 * Wraps the existing desktop-edit-session API endpoints:
 * open (acquire lock + presigned URL) → checkpoint (auto-save) → finalize / cancel.
 */

import { useEffect, useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useDebouncedCallback } from "use-debounce";

import { api } from "@/lib/api";
import { DOCX_MIME } from "@/lib/consts";
import { toSafeId } from "@/lib/safe-id";
import { filesKeys } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

type EditSessionState =
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
  /** Called after finalize succeeds (new version created). */
  onFinalized?: (result: FinalizeEditSessionResult) => void;
  /** Called after cancel/discard. */
  onCancelled?: () => void;
};

const CHECKPOINT_DEBOUNCE_MS = 5000;

type EditSessionReleaseContext = {
  workspaceId: string;
  entityId: string;
  propertyId: string;
};

const releaseEditSession = async ({
  workspaceId,
  entityId,
  propertyId,
}: EditSessionReleaseContext) =>
  await api
    .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["desktop-edit-sessions"].release.post({
      entityId: toSafeId<"entity">(entityId),
      propertyId: toSafeId<"property">(propertyId),
      queryKey: entitiesKeys.all(workspaceId),
    });

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
  onFinalized,
  onCancelled,
}: UseEditSessionOptions) => {
  const queryClient = useQueryClient();
  const [state, setState] = useState<EditSessionState>({ status: "idle" });
  const [isDirty, setIsDirty] = useState(false);
  const sessionRef = useRef<{
    sessionId: string;
    sessionToken: string;
  } | null>(null);
  const releaseContextRef = useRef({ workspaceId, entityId, propertyId });
  const isMountedRef = useRef(true);

  useEffect(() => {
    releaseContextRef.current = { workspaceId, entityId, propertyId };
  }, [entityId, propertyId, workspaceId]);

  // Warn the user before closing the tab with unsaved changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const open = async (force?: boolean) => {
    const releaseContext = { workspaceId, entityId, propertyId };
    releaseContextRef.current = releaseContext;
    setState({ status: "opening" });

    const response = await api
      .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["desktop-edit-sessions"].open.post({
        entityId: toSafeId<"entity">(entityId),
        propertyId: toSafeId<"property">(propertyId),
        ...(force && { force }),
      });

    if (response.error) {
      if (!isMountedRef.current) {
        return;
      }
      setState({
        status: "error",
        reason: getEditSessionErrorReason(response.error),
        source: "open",
      });
      return;
    }

    const { sessionId, sessionToken, downloadUrl, fileName } = response.data;
    sessionRef.current = { sessionId, sessionToken };
    if (!isMountedRef.current) {
      sessionRef.current = null;
      await releaseEditSession(releaseContext);
      return;
    }

    const fileResponse = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!fileResponse?.ok) {
      if (sessionRef.current !== null) {
        sessionRef.current = null;
        await releaseEditSession(releaseContext);
      }
      if (!isMountedRef.current) {
        return;
      }
      setState({
        status: "error",
        reason: "downloadFailed",
        source: "download",
      });
      return;
    }

    const buffer = await fileResponse.arrayBuffer();
    if (!isMountedRef.current) {
      if (sessionRef.current !== null) {
        sessionRef.current = null;
        await releaseEditSession(releaseContext);
      }
      return;
    }

    setState({
      status: "editing",
      sessionId,
      sessionToken,
      buffer,
      fileName,
    });
    await queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(workspaceId),
    });
  };

  const saveCheckpoint = async (docxBuffer: ArrayBuffer) => {
    const session = sessionRef.current;
    if (!session) {
      return false;
    }

    const file = new File([docxBuffer], "document.docx", {
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
        setIsDirty(false);
        setState({
          status: "error",
          reason: "takenOver",
          source: "checkpoint",
        });
      }
      return false;
    }

    if (response.data.rotatedSessionToken) {
      sessionRef.current = {
        sessionId: session.sessionId,
        sessionToken: response.data.rotatedSessionToken,
      };
    }
    setIsDirty(false);
    return true;
  };

  const debouncedCheckpoint = useDebouncedCallback((buffer: ArrayBuffer) => {
    void saveCheckpoint(buffer);
  }, CHECKPOINT_DEBOUNCE_MS);
  const debouncedCheckpointRef = useRef(debouncedCheckpoint);

  useEffect(() => {
    debouncedCheckpointRef.current = debouncedCheckpoint;
  }, [debouncedCheckpoint]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      debouncedCheckpointRef.current.cancel();
      const session = sessionRef.current;
      if (!session) {
        return;
      }

      sessionRef.current = null;
      const context = releaseContextRef.current;
      void releaseEditSession(context);
    };
  }, []);

  const markDirtyAndCheckpoint = (buffer: ArrayBuffer) => {
    setIsDirty(true);
    debouncedCheckpoint(buffer);
  };

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
    setIsDirty(false);

    if (response.error) {
      setState({
        status: "error",
        reason: getEditSessionErrorReason(response.error),
        source: "finalize",
      });
      return;
    }

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
    await releaseEditSession(context);

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
    /** Acquire lock and load the DOCX. */
    open,
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
