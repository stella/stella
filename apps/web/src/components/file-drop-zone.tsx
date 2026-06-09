import type { PropsWithChildren } from "react";

import { UploadIcon } from "lucide-react";

import { cn } from "@stll/ui/lib/utils";

import type { DroppedFileTree } from "@/hooks/external-file-drop.logic";
import { useExternalFileDrop } from "@/hooks/use-external-file-drop";

type FileDropZoneProps = PropsWithChildren<{
  /** Files dropped onto the zone (folders are flattened to their files). */
  onDrop: (files: File[]) => void;
  /** Opt in to preserving the dropped folder structure instead of flattening. */
  onDropTree?: (tree: DroppedFileTree) => void;
  /** Overlay copy shown while a drag is over the zone. */
  label: string;
  enabled?: boolean;
  className?: string;
}>;

/**
 * A drop target for external files: highlights on drag-over and forwards the
 * dropped files to the host. Shared by the workspace Files view and the skill
 * editor so both get identical drop behaviour and overlay from one place.
 */
export const FileDropZone = ({
  onDrop,
  onDropTree,
  label,
  enabled,
  className,
  children,
}: FileDropZoneProps) => {
  const { ref, isDropTarget, isInnerActive } = useExternalFileDrop({
    onDrop,
    onDropTree,
    enabled,
  });
  const showOverlay = isDropTarget && !isInnerActive;

  return (
    <div
      className={cn("relative flex min-h-0 flex-1 flex-col", className)}
      ref={ref}
    >
      {children}
      {showOverlay && (
        <div className="border-foreground/20 bg-foreground/5 pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed">
          <div className="text-foreground-subtle flex flex-col items-center gap-2">
            <UploadIcon className="size-8" />
            <span className="text-sm font-medium">{label}</span>
          </div>
        </div>
      )}
    </div>
  );
};
