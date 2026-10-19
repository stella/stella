import { useCallback } from "react";
import type { RefObject } from "react";

import type { DocxEditorRef } from "@stll/folio-react";

import { documentOpenTiming } from "@/lib/analytics/document-open-timing";

import { DOCX_TIMING_SURFACE } from "./use-docx-editor-viewport";
import type { DocxEditorSurface } from "./use-docx-editor-viewport";

type UseDocxOpenTimingOptions = {
  editorRef: RefObject<DocxEditorRef | null>;
  fieldId: string;
  surface: DocxEditorSurface;
};

/**
 * The editor ref that ends a document open at the first painted layout. The
 * live view is created lazily on first interaction, so it would time the
 * user, not the editor.
 */
export const useDocxOpenTiming = ({
  editorRef,
  fieldId,
  surface,
}: UseDocxOpenTimingOptions) =>
  useCallback(
    (editor: DocxEditorRef | null) => {
      editorRef.current = editor;
      if (editor === null) {
        return undefined;
      }
      const stopListening = editor.onLayoutChange(() => {
        stopListening();
        documentOpenTiming.editorReady(fieldId, DOCX_TIMING_SURFACE[surface]);
      });
      return () => {
        stopListening();
        editorRef.current = null;
      };
    },
    [editorRef, fieldId, surface],
  );
