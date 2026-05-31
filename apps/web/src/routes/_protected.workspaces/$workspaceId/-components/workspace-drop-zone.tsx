import type { PropsWithChildren } from "react";
import { useEffect, useRef, useState } from "react";

import { dropTargetForExternal } from "@atlaskit/pragmatic-drag-and-drop/external/adapter";
import {
  containsFiles,
  getFiles,
} from "@atlaskit/pragmatic-drag-and-drop/external/file";
import { UploadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { ExternalDragInfoProvider } from "@/routes/_protected.workspaces/$workspaceId/-context/external-drag-info";
import {
  RowDropTargetProvider,
  useIsRowDropTargetActive,
} from "@/routes/_protected.workspaces/$workspaceId/-context/row-drop-target-context";
import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";

type WorkspaceDropZoneProps = PropsWithChildren<{
  workspaceId: string;
}>;

export const WorkspaceDropZone = ({
  workspaceId,
  children,
}: WorkspaceDropZoneProps) => (
  <ExternalDragInfoProvider>
    <RowDropTargetProvider>
      <WorkspaceDropZoneInner workspaceId={workspaceId}>
        {children}
      </WorkspaceDropZoneInner>
    </RowDropTargetProvider>
  </ExternalDragInfoProvider>
);

const WorkspaceDropZoneInner = ({
  workspaceId,
  children,
}: WorkspaceDropZoneProps) => {
  const t = useTranslations();
  const dropRef = useRef<HTMLDivElement>(null);
  const [isPending, createFileEntities] = useCreateFileEntities(workspaceId);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const isRowDropTargetActive = useIsRowDropTargetActive();

  // Store isPending in a ref so the effect closure always
  // sees the latest value without re-registering.
  const isPendingRef = useRef(isPending);
  isPendingRef.current = isPending;

  const createFileEntitiesRef = useRef(createFileEntities);
  createFileEntitiesRef.current = createFileEntities;

  useEffect(() => {
    const el = dropRef.current;
    if (!el) {
      return undefined;
    }
    return dropTargetForExternal({
      element: el,
      canDrop: ({ source }) => containsFiles({ source }),
      onDragEnter: () => setIsDropTarget(true),
      onDragLeave: () => setIsDropTarget(false),
      onDrop: ({ source, location, self }) => {
        setIsDropTarget(false);
        // Pragmatic DnD calls `onDrop` on every drop target the pointer is
        // over. `location.current.dropTargets` is innermost-first, so bail
        // unless we are the innermost; otherwise a file dropped on a row
        // would be both added as a new version (by the row) and uploaded
        // as a new entity (by this WorkspaceDropZone).
        if (location.current.dropTargets[0]?.element !== self.element) {
          return;
        }
        if (isPendingRef.current) {
          return;
        }
        const files = getFiles({ source });
        if (files.length > 0) {
          createFileEntitiesRef.current(files);
        }
      },
    });
  }, []);

  // Suppress the WorkspaceDropZone overlay when a row-level drop target is active
  const showOverlay = isDropTarget && !isRowDropTargetActive;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" ref={dropRef}>
      {children}
      {showOverlay && (
        <div className="border-foreground/20 bg-foreground/5 pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed">
          <div className="text-foreground-subtle flex flex-col items-center gap-2">
            <UploadIcon className="size-8" />
            <span className="text-sm font-medium">
              {t("workspaces.dropToUploadFiles")}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
