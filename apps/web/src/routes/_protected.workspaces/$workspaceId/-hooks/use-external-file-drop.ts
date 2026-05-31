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
  /**
   * When true, `onDrop` only fires if this element is the innermost
   * drop target. Use this on catch-all container zones (e.g. the
   * workspace zone) so a drop on a nested leaf target (row, column)
   * doesn't double-fire — Pragmatic delivers `onDrop` to every target
   * in the stack, innermost first.
   */
  onlyIfInnermost?: boolean;
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
 * Hook for handling external file drops. Used at three layers:
 * - Leaves (rows) that claim drops unconditionally.
 * - Inner containers (kanban columns) that claim drops within their
 *   scope.
 * - Outer catch-all zones (workspace) that use `onlyIfInnermost` to
 *   defer to inner targets and `isInnerActive` to suppress overlays.
 */
export const useExternalFileDrop = ({
  onDrop,
  enabled = true,
  externalRef,
  accept,
  onlyIfInnermost = false,
}: ExternalFileDropOptions): ExternalFileDropResult => {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = externalRef ?? internalRef;
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [isInnerActive, setIsInnerActive] = useState(false);

  // Store callbacks/flags in refs to avoid re-registering the drop target
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  const onlyIfInnermostRef = useRef(onlyIfInnermost);
  onlyIfInnermostRef.current = onlyIfInnermost;

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
        if (
          onlyIfInnermostRef.current &&
          location.current.dropTargets[0]?.element !== self.element
        ) {
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
