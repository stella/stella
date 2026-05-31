import type { PropsWithChildren } from "react";

import { UploadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";
import { useExternalFileDrop } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-external-file-drop";

type WorkspaceDropZoneProps = PropsWithChildren<{
  workspaceId: string;
}>;

export const WorkspaceDropZone = ({
  workspaceId,
  children,
}: WorkspaceDropZoneProps) => {
  const t = useTranslations();
  const [isPending, createFileEntities] = useCreateFileEntities(workspaceId);
  const { ref, isDropTarget, isInnerActive } = useExternalFileDrop({
    onDrop: (files) => {
      if (isPending) {
        return;
      }
      createFileEntities(files);
    },
  });

  const showOverlay = isDropTarget && !isInnerActive;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" ref={ref}>
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
