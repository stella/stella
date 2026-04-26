/**
 * useEditSession — manages the lifecycle of a browser DOCX editing session.
 *
 * Wraps the existing desktop-edit-session API endpoints:
 * open (acquire lock + presigned URL) → checkpoint (auto-save) → finalize / cancel.
 */

import { useEffect, useRef, useState } from "react";

import { useDebouncedCallback } from "use-debounce";

import { api } from "@/lib/api";
import { DOCX_MIME } from "@/lib/consts";
import { toAPIError } from "@/lib/errors";
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
  | { status: "error"; message: string };

type UseEditSessionOptions = {
  workspaceId: string;
  entityId: string;
  propertyId: string;
  /** Called after finalize succeeds (new version created). */
  onFinalized?: () => void;
  /** Called after cancel/discard. */
  onCancelled?: () => void;
};

const CHECKPOINT_DEBOUNCE_MS = 5000;

export const useEditSession = ({
  workspaceId,
  entityId,
  propertyId,
  onFinalized,
  onCancelled,
}: UseEditSessionOptions) => {
  const [state, setState] = useState<EditSessionState>({ status: "idle" });
  const [isDirty, setIsDirty] = useState(false);
  const sessionRef = useRef<{
    sessionId: string;
    sessionToken: string;
  } | null>(null);

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
    setState({ status: "opening" });

    const response = await api
      .entities({ workspaceId })
      ["desktop-edit-sessions"].open.post({
        entityId,
        propertyId,
        ...(force && { force }),
      });

    if (response.error) {
      setState({
        status: "error",
        message: toAPIError(response.error).message,
      });
      return;
    }

    const { sessionId, sessionToken, downloadUrl, fileName } = response.data;
    sessionRef.current = { sessionId, sessionToken };

    // Fetch the DOCX file
    const fileResponse = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!fileResponse.ok) {
      setState({ status: "error", message: "Failed to download document." });
      return;
    }

    const buffer = await fileResponse.arrayBuffer();

    setState({
      status: "editing",
      sessionId,
      sessionToken,
      buffer,
      fileName,
    });
  };

  const checkpoint = async (docxBuffer: ArrayBuffer) => {
    const session = sessionRef.current;
    if (!session) {
      return;
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
      // 409 = session taken over by another user
      if (response.error.status === 409) {
        setState({
          status: "error",
          message: "Your editing session was taken over by another user.",
        });
        sessionRef.current = null;
        setIsDirty(false);
      }
      // Other errors: log but don't interrupt editing
    } else {
      setIsDirty(false);
    }
  };

  const debouncedCheckpoint = useDebouncedCallback((buffer: ArrayBuffer) => {
    void checkpoint(buffer);
  }, CHECKPOINT_DEBOUNCE_MS);

  const markDirtyAndCheckpoint = (buffer: ArrayBuffer) => {
    setIsDirty(true);
    debouncedCheckpoint(buffer);
  };

  const finalize = async () => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }

    // Flush any pending checkpoint first
    debouncedCheckpoint.flush();

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
        message: toAPIError(response.error).message,
      });
      return;
    }

    setState({ status: "idle" });
    onFinalized?.();
  };

  const cancel = async () => {
    const session = sessionRef.current;
    if (!session) {
      setState({ status: "idle" });
      onCancelled?.();
      return;
    }

    debouncedCheckpoint.cancel();

    await api.entities({ workspaceId })["desktop-edit-sessions"].release.post({
      entityId,
      propertyId,
      queryKey: entitiesKeys.all(workspaceId),
    });

    sessionRef.current = null;
    setIsDirty(false);
    setState({ status: "idle" });
    onCancelled?.();
  };

  return {
    state,
    /** Acquire lock and load the DOCX. */
    open,
    /** Mark the document dirty and queue a debounced checkpoint (auto-save). */
    checkpoint: markDirtyAndCheckpoint,
    /** Finalize: flush checkpoint, create new version, release lock. */
    finalize,
    /** Discard: cancel checkpoint, release lock, no new version. */
    cancel,
  };
};
