import { useCallback, useRef } from "react";
import type { RefObject } from "react";

import { useDebouncedCallback } from "use-debounce";

import type { DocxEditorRef } from "@stll/folio-react";

import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";

import {
  createTrailingSingleFlight,
  resolveCheckpointAutosaveStatus,
} from "./docx-edit-mode.logic";
import type { AutosaveStatus } from "./docx-edit-mode.logic";
import type { EditSession } from "./use-edit-session";

const CHANGE_CHECKPOINT_DELAY = 2000;

type UseDocxCheckpointAutosaveOptions = {
  editorRef: RefObject<DocxEditorRef | null>;
  hasSessionChangesRef: RefObject<boolean>;
  isCollaborativeEditing: boolean;
  isUnlocked: boolean;
  markDirty: () => void;
  saveCheckpoint: EditSession["saveCheckpoint"];
  setAutosaveStatus: (status: AutosaveStatus) => void;
};

/**
 * Checkpoints local edits to the edit session: after typing settles, on
 * Cmd/Ctrl+S, and on demand before a handoff. Collaborative editing persists
 * through the room instead and only tracks the pending status here.
 */
export const useDocxCheckpointAutosave = ({
  editorRef,
  hasSessionChangesRef,
  isCollaborativeEditing,
  isUnlocked,
  markDirty,
  saveCheckpoint,
  setAutosaveStatus,
}: UseDocxCheckpointAutosaveOptions) => {
  const changeCheckpointIdleCallbackRef = useRef<number | null>(null);

  // The debounced autosave, the awaitable flush, and the Cmd/Ctrl+S
  // handler all serialize the live editor and persist the buffer.
  // Firing two concurrently raced two `ref.save()` round-trips whose
  // `setAutosaveStatus` writes landed in nondeterministic order (and
  // `flushPendingChanges` cancelled only the queued timer, not an
  // in-flight save). Route every path through one single-flight
  // coordinator: concurrent triggers coalesce into one in-flight
  // save plus one trailing save. `ref.save()` re-snapshots the live
  // document when it runs, so the trailing save captures edits made
  // during the in-flight save (latest wins).
  const runCheckpointSave = useLatestCallback(async () => {
    if (isCollaborativeEditing) {
      // The Hocuspocus provider streams Yjs updates; materializing DOCX in the
      // browser is no longer part of the collaboration persistence path.
      return;
    }

    const ref = editorRef.current;
    if (!ref) {
      return;
    }
    setAutosaveStatus("syncing");
    const buffer = await ref.save({ selective: true });
    const outcome = buffer ? await saveCheckpoint(buffer) : "failed";
    setAutosaveStatus(
      resolveCheckpointAutosaveStatus({
        buffer: buffer ?? null,
        checkpointSaved: outcome === "saved",
      }),
    );
  });

  const reportCheckpointSaveError = useLatestCallback((error: unknown) => {
    getAnalytics().captureError(error);
    setAutosaveStatus("pending");
  });

  // Lazy-init once (React's sanctioned ref pattern): the coordinator
  // owns the in-flight/trailing state, which must survive rerenders.
  // Its `run`/`onError` are stable and read the latest committed
  // closures, so recreating it would only lose that state.
  const triggerCheckpointSaveRef = useRef<(() => Promise<void>) | null>(null);
  triggerCheckpointSaveRef.current ??= createTrailingSingleFlight({
    run: runCheckpointSave,
    onError: reportCheckpointSaveError,
  });
  const triggerCheckpointSave = useCallback(
    async () =>
      await (triggerCheckpointSaveRef.current?.() ?? Promise.resolve()),
    [],
  );

  const saveChangeCheckpoint = useCallback(() => {
    detached(
      triggerCheckpointSave(),
      "docx-browser-editor.trigger-checkpoint-save",
    );
  }, [triggerCheckpointSave]);

  // The checkpoint waits for the typing to stop, then for the main thread to
  // be idle. `useDebouncedCallback` owns the first wait; the idle handle is
  // not a debounce and stays a ref, because the cancel path has to reach it.
  const queueChangeCheckpointSave = useDebouncedCallback(() => {
    changeCheckpointIdleCallbackRef.current = window.requestIdleCallback(
      () => {
        changeCheckpointIdleCallbackRef.current = null;
        saveChangeCheckpoint();
      },
      { timeout: 2000 },
    );
  }, CHANGE_CHECKPOINT_DELAY);

  const clearQueuedChangeCheckpoint = useCallback(() => {
    queueChangeCheckpointSave.cancel();
    if (changeCheckpointIdleCallbackRef.current !== null) {
      window.cancelIdleCallback(changeCheckpointIdleCallbackRef.current);
      changeCheckpointIdleCallbackRef.current = null;
    }
  }, [queueChangeCheckpointSave]);

  // Awaitable variant of `saveChangeCheckpoint` for callers that
  // need to wait for the round-trip before navigating (e.g. the
  // sidepeek → full view handoff). Cancels the queued debounced
  // checkpoint so we don't fire it twice; the coordinator coalesces
  // an already in-flight save into the trailing run this awaits.
  const flushPendingChanges = useCallback(async () => {
    clearQueuedChangeCheckpoint();
    await triggerCheckpointSave();
  }, [clearQueuedChangeCheckpoint, triggerCheckpointSave]);

  // Cmd+S / Ctrl+S checkpoints only while the document is actively editable.
  useExternalSyncEffect(() => {
    if (!isUnlocked) {
      return undefined;
    }

    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "s") {
        return;
      }

      e.preventDefault();
      clearQueuedChangeCheckpoint();
      detached(
        triggerCheckpointSave(),
        "docx-browser-editor.trigger-checkpoint-save",
      );
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [clearQueuedChangeCheckpoint, isUnlocked, triggerCheckpointSave]);

  useMountEffect(() => () => {
    clearQueuedChangeCheckpoint();
  });

  const handleChange = useCallback(() => {
    if (!isUnlocked) {
      return;
    }

    hasSessionChangesRef.current = true;
    markDirty();
    clearQueuedChangeCheckpoint();
    if (isCollaborativeEditing) {
      setAutosaveStatus("pending");
      return;
    }

    setAutosaveStatus("pending");
    queueChangeCheckpointSave();
  }, [
    clearQueuedChangeCheckpoint,
    hasSessionChangesRef,
    isCollaborativeEditing,
    isUnlocked,
    markDirty,
    queueChangeCheckpointSave,
    setAutosaveStatus,
  ]);

  return { clearQueuedChangeCheckpoint, flushPendingChanges, handleChange };
};
