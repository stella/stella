import type { PropsWithChildren } from "react";

import { UploadIcon } from "lucide-react";

import { cn } from "@stll/ui/utils";

import type { DroppedFileTree } from "@/hooks/external-file-drop.logic";
import { useExternalFileDrop } from "@/hooks/use-external-file-drop";

const FILE_DROP_ZONE_COVERAGE = {
  CONTENT: "content",
  VIEWPORT: "viewport",
} as const;

type FileDropZoneCoverage =
  (typeof FILE_DROP_ZONE_COVERAGE)[keyof typeof FILE_DROP_ZONE_COVERAGE];

const FILE_DROP_ZONE_COVERAGE_CLASSES = {
  [FILE_DROP_ZONE_COVERAGE.CONTENT]: "min-h-0",
  [FILE_DROP_ZONE_COVERAGE.VIEWPORT]: "min-h-full",
} as const satisfies Record<FileDropZoneCoverage, string>;

type FileDropZoneProps = PropsWithChildren<{
  /** Files dropped onto the zone (folders are flattened to their files). */
  onDrop: (files: File[]) => void;
  /** Opt in to preserving the dropped folder structure instead of flattening. */
  onDropTree?: (tree: DroppedFileTree) => void;
  /** Overlay copy shown while a drag is over the zone. */
  label: string;
  /** Whether the zone follows its content or covers its scroll viewport. */
  coverage: FileDropZoneCoverage;
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
  coverage,
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
      className={cn(
        "relative flex flex-1 flex-col",
        FILE_DROP_ZONE_COVERAGE_CLASSES[coverage],
        className,
      )}
      data-slot="file-drop-zone"
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
