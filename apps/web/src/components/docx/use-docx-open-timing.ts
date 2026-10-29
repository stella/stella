import { useCallback } from "react";
import type { RefObject } from "react";

import type { DocxEditorRef } from "@stll/folio-react";

import { documentOpenTiming } from "@/lib/analytics/document-open-timing";

import { DOCX_TIMING_SURFACE } from "./use-docx-editor-viewport";
import type { DocxEditorSurface } from "./use-docx-editor-viewport";

type UseDocxOpenTimingOptions = {
  editorRef: RefObject<TimedDocxEditor | null>;
  fieldId: string;
  surface: DocxEditorSurface;
};

type TimedDocxEditor = Pick<
  DocxEditorRef,
  "ensureEditorView" | "onLayoutChange"
>;

/**
 * The editor ref that eagerly creates the live view and ends a document open
 * at its first painted layout.
 */
export const useDocxOpenTiming = ({
  editorRef,
  fieldId,
  surface,
}: UseDocxOpenTimingOptions) =>
  useCallback(
    (editor: TimedDocxEditor | null) => {
      editorRef.current = editor;
      if (editor === null) {
        return undefined;
      }
      const stopListening = editor.onLayoutChange(() => {
        stopListening();
        documentOpenTiming.editorReady(fieldId, DOCX_TIMING_SURFACE[surface]);
      });
      editor.ensureEditorView({ focus: false });
      return () => {
        stopListening();
        editorRef.current = null;
      };
    },
    [editorRef, fieldId, surface],
  );
