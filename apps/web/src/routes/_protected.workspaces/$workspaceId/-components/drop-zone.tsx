import { useEffect, useRef, useState, type PropsWithChildren } from "react";
import { dropTargetForExternal } from "@atlaskit/pragmatic-drag-and-drop/external/adapter";
import {
  containsFiles,
  getFiles,
} from "@atlaskit/pragmatic-drag-and-drop/external/file";
import { UploadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";

type DropZoneProps = PropsWithChildren<{
  workspaceId: string;
}>;

export const DropZone = ({ workspaceId, children }: DropZoneProps) => {
  const t = useTranslations();
  const dropRef = useRef<HTMLDivElement>(null);
  const [isPending, createFileEntities] = useCreateFileEntities(workspaceId);
  const [isDropTarget, setIsDropTarget] = useState(false);

  // Store isPending in a ref so the effect closure always
  // sees the latest value without re-registering.
  const isPendingRef = useRef(isPending);
  isPendingRef.current = isPending;

  const createFileEntitiesRef = useRef(createFileEntities);
  createFileEntitiesRef.current = createFileEntities;

  useEffect(() => {
    const el = dropRef.current;
    if (!el) {
      return;
    }
    return dropTargetForExternal({
      element: el,
      canDrop: containsFiles,
      onDragEnter: () => setIsDropTarget(true),
      onDragLeave: () => setIsDropTarget(false),
      onDrop: ({ source }) => {
        setIsDropTarget(false);
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

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" ref={dropRef}>
      {children}
      {isDropTarget && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-foreground/20 bg-foreground/5">
          <div className="flex flex-col items-center gap-2 text-foreground/50">
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
