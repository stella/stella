/**
 * useDocumentLoader — encapsulates DOCX loading, parsing, and buffer management.
 *
 * Extracted from DocxEditor to keep the component focused on rendering.
 */

import { useRef, useCallback, useEffect } from "react";

import { inspectDocxCompatibility } from "../../core/docx/compatibility";
import type { DocxCompatibility } from "../../core/docx/compatibility";
import { parseDocx } from "../../core/docx/parser";
import type { Document } from "../../core/types/document";
import { resetAuthorColors } from "../../core/utils/authorColors";
import type { DocxInput } from "../../core/utils/docxInput";
import { loadFontsWithMapping } from "../../core/utils/fontLoader";
import type { UseHistoryReturn } from "../../hooks/useHistory";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UseDocumentLoaderParams = {
  /** Raw DOCX input (ArrayBuffer, Uint8Array, Blob, or File). */
  documentBuffer: DocxInput | null | undefined;
  /** Pre-parsed document (alternative to documentBuffer). */
  initialDocument: Document | null | undefined;
  /** History instance — used to reset/push document state. */
  history: UseHistoryReturn<Document | null>;
  /** Called when an unrecoverable parse error occurs. */
  onError: ((error: Error) => void) | undefined;
  /** Called after parsing to report whether editing can preserve fidelity. */
  onCompatibilityChange:
    | ((compatibility: DocxCompatibility) => void)
    | undefined;
  /**
   * Callback invoked at the start of every load to let the host component
   * clear UI state that is coupled to the previous document (comments,
   * tracked-change sidebar, find-replace matches, etc.).
   */
  onReset: () => void;
  /** Set the document loading slice of EditorState. */
  setDocumentLoadState: (state: DocumentLoadState) => void;
};

export type DocumentLoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

type UseDocumentLoaderReturn = {
  /** Parse and load a raw DOCX buffer. */
  loadBuffer: (buffer: DocxInput) => Promise<void>;
  /** Load a pre-parsed Document. */
  loadParsedDocument: (doc: Document) => void;
  /** Reset internal + UI state for a fresh document. */
  resetForNewDocument: () => void;
  /** Ref holding the original ArrayBuffer for selective save / repack. */
  originalBufferRef: React.RefObject<ArrayBuffer | null>;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export const useDocumentLoader = ({
  documentBuffer,
  initialDocument,
  history,
  onError,
  onCompatibilityChange,
  onReset,
  setDocumentLoadState,
}: UseDocumentLoaderParams): UseDocumentLoaderReturn => {
  // Monotonically increasing generation counter to discard stale async loads
  const loadGenerationRef = useRef(0);

  /** Original DOCX buffer kept for selective save / full repack. */
  const originalBufferRef = useRef<ArrayBuffer | null>(null);

  // -------------------------------------------------------------------
  // resetForNewDocument
  // -------------------------------------------------------------------

  const resetForNewDocument = useCallback(() => {
    resetAuthorColors();
    onReset();
  }, [onReset]);

  // -------------------------------------------------------------------
  // loadParsedDocument
  // -------------------------------------------------------------------

  const loadParsedDocument = useCallback(
    (doc: Document) => {
      resetForNewDocument();
      history.reset(doc);
      onCompatibilityChange?.(inspectDocxCompatibility(doc));
      setDocumentLoadState({ status: "ready" });
      // Defer font loading so the first page renders immediately
      if (doc.requiredFonts && doc.requiredFonts.length > 0) {
        loadFontsWithMapping(doc.requiredFonts).catch(() => undefined);
      }
    },
    [resetForNewDocument, history, onCompatibilityChange, setDocumentLoadState],
  );

  // -------------------------------------------------------------------
  // loadBuffer
  // -------------------------------------------------------------------

  const loadBuffer = useCallback(
    async (buffer: DocxInput) => {
      const generation = ++loadGenerationRef.current;
      const hasLoadedDocument = history.state !== null;
      if (!hasLoadedDocument) {
        setDocumentLoadState({ status: "loading" });
      }

      try {
        // Skip blocking font preload during parsing; fonts are loaded
        // asynchronously by loadParsedDocument after the first render
        const doc = await parseDocx(buffer, { preloadFonts: false });
        // Discard result if a newer load was started while we were parsing
        if (loadGenerationRef.current !== generation) {
          return;
        }
        loadParsedDocument(doc);
      } catch (error) {
        if (loadGenerationRef.current !== generation) {
          return;
        }
        const message =
          error instanceof Error ? error.message : "Failed to parse document";
        setDocumentLoadState({ status: "error", message });
        onError?.(error instanceof Error ? error : new Error(message));
      }
    },
    [history.state, loadParsedDocument, onError, setDocumentLoadState],
  );

  // -------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------

  // React to document/documentBuffer prop changes
  useEffect(() => {
    if (!documentBuffer) {
      if (initialDocument) {
        loadParsedDocument(initialDocument);
      }
      return;
    }

    loadBuffer(documentBuffer);
  }, [documentBuffer, initialDocument]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep original buffer for save/export
  useEffect(() => {
    if (documentBuffer) {
      originalBufferRef.current =
        documentBuffer instanceof ArrayBuffer ? documentBuffer : null;
    }
  }, [documentBuffer]);

  return {
    loadBuffer,
    loadParsedDocument,
    resetForNewDocument,
    originalBufferRef,
  };
};
