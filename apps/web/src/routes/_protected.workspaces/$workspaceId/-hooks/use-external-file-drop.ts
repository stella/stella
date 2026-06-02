import { useEffect, useRef, useState } from "react";

import { dropTargetForExternal } from "@atlaskit/pragmatic-drag-and-drop/external/adapter";
import {
  containsFiles,
  getFiles,
} from "@atlaskit/pragmatic-drag-and-drop/external/file";

type ExternalFileDropOptions = {
  onDrop: (files: File[]) => void;
  enabled?: boolean;
  /**
   * Optional caller-provided DOM ref; can be used when the target element
   * already has an existing ref. If omitted, the hook creates one.
   */
  externalRef?: React.RefObject<HTMLDivElement | null>;
};

type ExternalFileDropResult = {
  /** Ref to attach to the drop target element (only use if externalRef not provided) */
  ref: React.RefObject<HTMLDivElement | null>;
  /** Whether this element is currently a drop target */
  isDropTarget: boolean;
  /**
   * True while a descendant drop target is the innermost. Use this on
   * container zones to suppress overlays while a row claims the
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
}: ExternalFileDropOptions): ExternalFileDropResult => {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = externalRef ?? internalRef;
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [isInnerActive, setIsInnerActive] = useState(false);

  // Store callback in a ref to avoid re-registering the drop target
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) {
      return undefined;
    }

    return dropTargetForExternal({
      element: el,
      canDrop: ({ source }) => containsFiles({ source }),
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
