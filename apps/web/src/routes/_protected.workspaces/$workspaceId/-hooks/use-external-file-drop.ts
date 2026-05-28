import { useCallback, useEffect, useRef, useState } from "react";

import { dropTargetForExternal } from "@atlaskit/pragmatic-drag-and-drop/external/adapter";
import {
  containsFiles,
  getFiles,
} from "@atlaskit/pragmatic-drag-and-drop/external/file";

import { useRowDropTarget } from "@/routes/_protected.workspaces/$workspaceId/-context/row-drop-target-context";

type ExternalFileDropOptions = {
  /** Unique identifier for this drop target (typically entityId) */
  id: string;
  /** Called when files are dropped. Receives the dropped files. */
  onDrop: (files: File[]) => void;
  /** Whether this drop target is enabled */
  enabled?: boolean;
  /** Optional external ref to use instead of creating a new one */
  externalRef?: React.RefObject<HTMLDivElement | null>;
  /**
   * MIME type of the row's underlying file. When provided, the row only
   * activates as a drop target for a single-file drag whose MIME type
   * matches. Multi-file drags and mismatched single-file drags fall
   * through to the parent DropZone.
   *
   * Filenames aren't exposed during `dragover` (browser security), so MIME
   * is the only mid-drag signal we have. It's a heuristic — the on-drop
   * extension check in the dialog remains the source of truth.
   */
  expectedMimeType?: string | null | undefined;
};

type ExternalFileDropResult = {
  /** Ref to attach to the drop target element (only use if externalRef not provided) */
  ref: React.RefObject<HTMLDivElement | null>;
  /** Whether this element is currently a drop target */
  isDropTarget: boolean;
};

/**
 * Hook for handling external file drops on row elements.
 * Coordinates with RowDropTargetContext to suppress parent DropZone overlay.
 */
export const useExternalFileDrop = ({
  id,
  onDrop,
  enabled = true,
  externalRef,
  expectedMimeType,
}: ExternalFileDropOptions): ExternalFileDropResult => {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = externalRef ?? internalRef;
  const [isDropTarget, setIsDropTarget] = useState(false);
  const { setActiveRowId } = useRowDropTarget();

  // Store callbacks in refs to avoid re-registering the drop target
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  // expectedMimeType is read inside canDrop, which fires per drag. Holding
  // it in a ref avoids tearing down the drop target mid-drag if the value
  // changes between renders.
  const expectedMimeTypeRef = useRef(expectedMimeType);
  expectedMimeTypeRef.current = expectedMimeType;

  const handleDragEnter = useCallback(() => {
    setIsDropTarget(true);
    setActiveRowId(id);
  }, [id, setActiveRowId]);

  const handleDragLeave = useCallback(() => {
    setIsDropTarget(false);
    setActiveRowId(null);
  }, [setActiveRowId]);

  const handleDrop = useCallback(
    (files: File[]) => {
      setIsDropTarget(false);
      setActiveRowId(null);
      if (files.length > 0) {
        onDropRef.current(files);
      }
    },
    [setActiveRowId],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) {
      return undefined;
    }

    return dropTargetForExternal({
      element: el,
      canDrop: ({ source }) => {
        if (!containsFiles({ source })) {
          return false;
        }
        const fileItems = source.items.filter((item) => item.kind === "file");
        // Multi-file drags fall through to the parent DropZone (batch
        // upload intent, not version replacement).
        if (fileItems.length !== 1) {
          return false;
        }
        const expected = expectedMimeTypeRef.current;
        if (expected !== null && expected !== undefined) {
          const dragged = fileItems[0]?.type.toLowerCase() ?? "";
          if (dragged !== expected.toLowerCase()) {
            return false;
          }
        }
        return true;
      },
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDrop: ({ source }) => {
        const files = getFiles({ source });
        handleDrop(files);
      },
    });
  }, [enabled, handleDragEnter, handleDragLeave, handleDrop, ref]);

  return { ref, isDropTarget };
};
