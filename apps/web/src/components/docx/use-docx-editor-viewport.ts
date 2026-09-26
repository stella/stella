import { useMemo } from "react";
import type { RefObject } from "react";

import type { DocxEditorRef } from "@stll/folio-react";
import { composeRefs } from "@stll/ui/utils";

import { useDocxFitZoom } from "@/components/docx-preview-zoom";
import { useDocxFind } from "@/components/docx/use-docx-find";
import { useFindSurface } from "@/lib/find-owner";

/** The inspector docks the editor beside the page; full view owns the page. */
export type DocxEditorSurface = "fullView" | "inspector";

type UseDocxEditorViewportOptions = {
  containerRef: RefObject<HTMLDivElement | null>;
  editorRef: RefObject<DocxEditorRef | null>;
  scaleOffset: number;
  surface: DocxEditorSurface;
};

/** Fits the page to the container and routes Cmd/Ctrl+F for the surface. */
export const useDocxEditorViewport = ({
  containerRef,
  editorRef,
  scaleOffset,
  surface,
}: UseDocxEditorViewportOptions) => {
  const { containerRef: fitZoomRef, fitZoom: targetZoom } = useDocxFitZoom({
    scaleOffset,
    maxAutoZoom: 0.85,
  });
  // Stable ref callback so React doesn't detach/re-attach the fit-zoom
  // ResizeObserver every render.
  const composedContainerRef = useMemo(
    () => composeRefs(containerRef, fitZoomRef),
    [containerRef, fitZoomRef],
  );
  // Full view leaves Cmd+F to Folio's own dialog, which has the whole
  // viewport to sit in; only the docked inspector needs its own bar.
  const find = useDocxFind({
    containerRef,
    editorRef,
    enabled: surface === "inspector",
  });
  // The full view is a surface of the registry too, or the inspector docked
  // beside it (a reference preview, a DOCX tab) would take a press with the
  // caret in this editor and open its bar over Folio's dialog. Folio answers a
  // press inside its own root itself (`keyboardShortcuts="editor"` on the
  // editor, which also keeps print, replace and delete-table); the registry
  // sends it the presses outside, which is what Folio's page-wide binding used
  // to give the reader.
  useFindSurface({
    enabled: surface === "fullView",
    onFind: () => editorRef.current?.openFind(),
    owner: "document",
    root: containerRef,
    scope: "app",
  });

  return { composedContainerRef, find, targetZoom };
};
