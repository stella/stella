import { useEffect, useRef, useState } from "react";

import { dropTargetForExternal } from "@atlaskit/pragmatic-drag-and-drop/external/adapter";
import {
  containsFiles,
  getFiles,
} from "@atlaskit/pragmatic-drag-and-drop/external/file";

import type { ExternalDragInfo } from "@/routes/_protected.workspaces/$workspaceId/-context/external-drag-info";
import { getCurrentExternalDrag } from "@/routes/_protected.workspaces/$workspaceId/-context/external-drag-info";

type ExternalFileDropOptions = {
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
   * WorkspaceDropZone instead.
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
 * Hook for handling external file drops on row elements. The parent
 * `WorkspaceDropZone` observes its own `onDropTargetChange` to suppress
 * its overlay while a row is the innermost target, so this hook only
 * has to register the per-row drop target.
 */
export const useExternalFileDrop = ({
  onDrop,
  enabled = true,
  externalRef,
  accept,
}: ExternalFileDropOptions): ExternalFileDropResult => {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = externalRef ?? internalRef;
  const [isDropTarget, setIsDropTarget] = useState(false);

  // Store callbacks in refs to avoid re-registering the drop target
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const acceptRef = useRef(accept);
  acceptRef.current = accept;

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
      onDragEnter: () => setIsDropTarget(true),
      onDragLeave: () => setIsDropTarget(false),
      onDrop: ({ source }) => {
        setIsDropTarget(false);
        const files = getFiles({ source });
        if (files.length > 0) {
          onDropRef.current(files);
        }
      },
    });
  }, [enabled, ref]);

  return { ref, isDropTarget };
};
