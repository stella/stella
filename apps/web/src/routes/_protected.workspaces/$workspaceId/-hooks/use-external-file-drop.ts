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
   * Optional filter on the drag info (mime types, file count). Return
   * false to skip this target so the drop falls through to an outer
   * container. Omit to accept any external file. If drag info isn't
   * available yet, the target rejects.
   */
  accept?: (info: ExternalDragInfo) => boolean;
};

type ExternalFileDropResult = {
  /** Ref to attach to the drop target element (only use if externalRef not provided) */
  ref: React.RefObject<HTMLDivElement | null>;
  /** Whether this element is currently a drop target */
  isDropTarget: boolean;
  /**
   * True while a descendant drop target is the innermost. Use this on
   * container zones to suppress overlays while a row/column claims the
   * drag.
   */
  isInnerActive: boolean;
};

/**
 * Hook for handling external file drops. Always defers to the
 * innermost drop target: `onDrop` only fires if this element is
 * innermost (Pragmatic-correct semantics; prevents double-fire when
 * nested). Containers can read `isInnerActive` to suppress overlays
 * while a descendant claims the drag.
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
  const [isInnerActive, setIsInnerActive] = useState(false);

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
      onDragLeave: () => {
        setIsDropTarget(false);
        setIsInnerActive(false);
      },
      onDropTargetChange: ({ location, self }) => {
        const innermost = location.current.dropTargets[0];
        setIsInnerActive(!!innermost && innermost.element !== self.element);
      },
      onDrop: ({ source, location, self }) => {
        setIsDropTarget(false);
        setIsInnerActive(false);
        if (location.current.dropTargets[0]?.element !== self.element) {
          return;
        }
        const files = getFiles({ source });
        if (files.length > 0) {
          onDropRef.current(files);
        }
      },
    });
  }, [enabled, ref]);

  return { ref, isDropTarget, isInnerActive };
};
