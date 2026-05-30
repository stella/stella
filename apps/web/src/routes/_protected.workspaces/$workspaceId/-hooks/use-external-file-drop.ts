import { useCallback, useEffect, useRef, useState } from "react";

import { dropTargetForExternal } from "@atlaskit/pragmatic-drag-and-drop/external/adapter";
import {
  containsFiles,
  getFiles,
} from "@atlaskit/pragmatic-drag-and-drop/external/file";

import type { ExternalDragInfo } from "@/routes/_protected.workspaces/$workspaceId/-context/external-drag-info";
import { getCurrentExternalDrag } from "@/routes/_protected.workspaces/$workspaceId/-context/external-drag-info";
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
   * Optional pre-drop filter. Called inside Pragmatic DnD's `canDrop`,
   * which fires outside React's render cycle. The drag info is read
   * synchronously from `ExternalDragInfoProvider`. Returning false makes
   * Pragmatic skip this drop target so the drop falls through to the
   * parent DropZone instead.
   *
   * If omitted, defaults to accepting any external file drag. When info
   * is unavailable (listener hasn't fired yet) the predicate is treated
   * as rejecting — better to fall through to the workspace overlay than
   * to highlight a row that may not match.
   */
  accept?: (info: ExternalDragInfo) => boolean;
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
  accept,
}: ExternalFileDropOptions): ExternalFileDropResult => {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = externalRef ?? internalRef;
  const [isDropTarget, setIsDropTarget] = useState(false);
  const { setActiveRowId } = useRowDropTarget();

  // Store callbacks in refs to avoid re-registering the drop target
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const acceptRef = useRef(accept);
  acceptRef.current = accept;

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
        const acceptFn = acceptRef.current;
        if (!acceptFn) {
          return true;
        }
        const info = getCurrentExternalDrag();
        if (!info) {
          return false;
        }
        return acceptFn(info);
      },
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDrop: ({ source }) => {
        handleDrop(getFiles({ source }));
      },
    });
  }, [enabled, handleDragEnter, handleDragLeave, handleDrop, ref]);

  return { ref, isDropTarget };
};
