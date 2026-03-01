import { useRef, type PropsWithChildren } from "react";
import { UploadIcon } from "lucide-react";
import { useDrop } from "react-aria";
import { useTranslations } from "use-intl";

import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";

type DropZoneProps = PropsWithChildren<{
  workspaceId: string;
}>;

export const DropZone = ({ workspaceId, children }: DropZoneProps) => {
  const t = useTranslations();
  const dropRef = useRef<HTMLDivElement>(null);
  const [isPending, createFileEntities] = useCreateFileEntities(workspaceId);

  const { dropProps, isDropTarget } = useDrop({
    ref: dropRef,
    async onDrop(e) {
      if (isPending) {
        return;
      }
      const files = await Promise.all(
        e.items
          .filter((item) => item.kind === "file")
          .map((item) => item.getFile()),
      );
      if (files.length > 0) {
        createFileEntities(files);
      }
    },
  });

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      ref={dropRef}
      {...dropProps}
    >
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
