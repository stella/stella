import { useCallback, useImperativeHandle } from "react";
import type { RefObject } from "react";

import { panic } from "better-result";

import type { DocxEditorRef } from "@stll/folio-react";

import { detached } from "@/lib/detached";

import { getDocxLeaveAction } from "./docx-browser-editor.logic";
import type { DocxEditModeResult } from "./docx-browser-editor.logic";
import type { EditSession } from "./use-edit-session";

export type DocxBrowserEditorActions = {
  cancel: () => Promise<void>;
  finalize: () => Promise<boolean>;
  leave: () => Promise<boolean>;
  /**
   * Force-checkpoint any pending in-flight edits to the server,
   * bypassing the debounce. Call this before navigating away from
   * the editor (e.g. the sidepeek → full view handoff) so the
   * next mount of the same edit session downloads the user's
   * latest changes instead of an older snapshot. Resolves once
   * the checkpoint round-trip completes; rejects only on
   * unexpected errors (network failures are surfaced through the
   * autosave status).
   */
  flushPendingChanges: () => Promise<void>;
  print: () => void;
  unlock: () => void;
};

type UseDocxBrowserEditorActionsOptions = {
  actionsKey: string | undefined;
  actionsMapRef: RefObject<Map<string, DocxBrowserEditorActions>> | undefined;
  actionsRef: RefObject<DocxBrowserEditorActions | null> | undefined;
  editSession: EditSession;
  editorRef: RefObject<DocxEditorRef | null>;
  flushPendingChanges: () => Promise<void>;
  handleCancel: () => Promise<void>;
  handleFinalize: () => Promise<boolean>;
  isCollaborativeEditing: boolean;
  requestEditMode: () => Promise<DocxEditModeResult>;
};

/**
 * Hands the editor's action handles to the parent through `actionsRef`
 * and/or the keyed `actionsMapRef`.
 */
export const useDocxBrowserEditorActions = ({
  actionsKey,
  actionsMapRef,
  actionsRef,
  editSession,
  editorRef,
  flushPendingChanges,
  handleCancel,
  handleFinalize,
  isCollaborativeEditing,
  requestEditMode,
}: UseDocxBrowserEditorActionsOptions) => {
  const { finalize: finalizeActiveSession, state } = editSession;

  // Registers this render's action handles into the parent-provided ref
  // and/or keyed map. Wrapped in useCallback (stable unless actionsKey /
  // actionsMapRef / actionsRef change) so useImperativeHandle only
  // re-attaches for those changes or for its own dep list below.
  const registerActions = useCallback(
    (actions: DocxBrowserEditorActions | null) => {
      if (!actions) {
        return undefined;
      }
      const actionsMap = actionsMapRef?.current;
      if (actionsRef) {
        actionsRef.current = actions;
      }
      if (actionsMap && actionsKey) {
        actionsMap.set(actionsKey, actions);
      }

      return () => {
        if (actionsRef?.current === actions) {
          actionsRef.current = null;
        }
        if (
          actionsMap &&
          actionsKey &&
          actionsMap.get(actionsKey) === actions
        ) {
          actionsMap.delete(actionsKey);
        }
      };
    },
    [actionsKey, actionsMapRef, actionsRef],
  );

  const handleDesktopSessionExit = useCallback(async () => {
    switch (getDocxLeaveAction(state)) {
      case "allow":
        return true;
      case "block":
        return false;
      case "finalize":
        return await handleFinalize();
      case "retryFinalize":
        return await finalizeActiveSession();
      default:
        return panic("Unsupported DOCX exit action");
    }
  }, [finalizeActiveSession, handleFinalize, state]);

  useImperativeHandle(
    registerActions,
    () => ({
      cancel: handleCancel,
      finalize: async () => {
        if (isCollaborativeEditing) {
          return await handleFinalize();
        }
        return await handleDesktopSessionExit();
      },
      flushPendingChanges,
      leave: async () => {
        if (isCollaborativeEditing) {
          // Collaboration owns its snapshot lifecycle. Cancelling it from a
          // route blocker races the room cleanup against its final flush.
          return true;
        }
        return await handleDesktopSessionExit();
      },
      print: () => {
        editorRef.current?.print();
      },
      unlock: () => {
        detached(requestEditMode(), "docx-browser-editor.request-edit-mode");
      },
    }),
    [
      editorRef,
      flushPendingChanges,
      handleCancel,
      handleDesktopSessionExit,
      handleFinalize,
      isCollaborativeEditing,
      requestEditMode,
    ],
  );
};
