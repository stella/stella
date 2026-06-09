import { useEffect, useRef, useState } from "react";

import { dropTargetForExternal } from "@atlaskit/pragmatic-drag-and-drop/external/adapter";
import { containsFiles } from "@atlaskit/pragmatic-drag-and-drop/external/file";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import {
  collectDroppedFileTree,
  type DroppedFileTree,
} from "@/hooks/external-file-drop.logic";
import { ClientOperationError } from "@/lib/errors";

type ExternalFileDropOptions = {
  onDrop: (files: File[]) => void;
  // Optionals accept explicit `undefined` (exactOptionalPropertyTypes) so wrapper
  // components like FileDropZone can forward their own optional props through.
  onDropTree?: ((tree: DroppedFileTree) => void) | undefined;
  onError?: ((error: Error) => void) | undefined;
  enabled?: boolean | undefined;
  /**
   * Optional caller-provided DOM ref; can be used when the target element
   * already has an existing ref. If omitted, the hook creates one.
   */
  externalRef?: React.RefObject<HTMLDivElement | null> | undefined;
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
  onDropTree,
  onError,
  enabled = true,
  externalRef,
}: ExternalFileDropOptions): ExternalFileDropResult => {
  const t = useTranslations();
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = externalRef ?? internalRef;
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [isInnerActive, setIsInnerActive] = useState(false);

  // Store callback in a ref to avoid re-registering the drop target
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const onDropTreeRef = useRef(onDropTree);
  onDropTreeRef.current = onDropTree;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

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
        void collectDroppedFileTree(source)
          .then((tree) => {
            if (tree.files.length === 0 && tree.directoryPaths.length === 0) {
              return undefined;
            }

            if (onDropTreeRef.current) {
              onDropTreeRef.current(tree);
              return undefined;
            }

            const files = tree.files.map(({ file }) => file);
            if (files.length > 0) {
              onDropRef.current(files);
            }
            return undefined;
          })
          .catch((error: unknown) => {
            const normalized =
              error instanceof Error
                ? error
                : new ClientOperationError({
                    action: "read-dropped-files",
                    message: "Failed to read dropped files",
                    cause: error,
                  });
            onErrorRef.current?.(normalized);
            stellaToast.add({
              title: t("errors.uploadFailed"),
              type: "error",
            });
          });
      },
    });
  }, [enabled, ref, t]);

  return { ref, isDropTarget, isInnerActive };
};
