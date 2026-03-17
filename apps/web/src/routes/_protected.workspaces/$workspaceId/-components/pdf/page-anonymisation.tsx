import { useShallow } from "zustand/react/shallow";

import { cn } from "@stella/ui/lib/utils";

import { ENTITY_COLORS } from "@/lib/anonymize/ui-constants";
import { useAnonymiseOverlayStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymise-pdf";

const RECT_PADDING = 2;

type PageAnonymisationProps = {
  fileId: string;
  /** 0-based page index. */
  pageIndex: number;
  originalWidth: number;
  originalHeight: number;
  scale: number;
};

export const PageAnonymisation = ({
  fileId,
  pageIndex,
  originalWidth,
  originalHeight,
  scale,
}: PageAnonymisationProps) => {
  const overlays = useAnonymiseOverlayStore(
    useShallow((s) => s.overlays.get(fileId)?.get(pageIndex)),
  );

  if (!overlays || overlays.length === 0) {
    return null;
  }

  const overlayWidth = originalWidth * scale;
  const overlayHeight = originalHeight * scale;

  return (
    <div
      aria-hidden={true}
      className="pointer-events-none absolute top-0 left-0"
      style={{
        width: overlayWidth,
        height: overlayHeight,
      }}
    >
      {overlays.flatMap((entity, entityIdx) =>
        entity.bboxes
          .filter((bbox) => bbox.pageIndex === pageIndex)
          .map((bbox, bboxIdx) => {
            // PDF coordinates: origin is bottom-left.
            // CSS coordinates: origin is top-left.
            const left = (bbox.x - RECT_PADDING) * scale;
            const top =
              (originalHeight - bbox.y - bbox.height - RECT_PADDING) * scale;
            const width = (bbox.width + RECT_PADDING * 2) * scale;
            const height = (bbox.height + RECT_PADDING * 2) * scale;

            const colorClass =
              ENTITY_COLORS[entity.label] ?? "bg-gray-200 dark:bg-gray-700";

            return (
              <div
                key={`${entityIdx}-${bboxIdx}-${bbox.x}-${bbox.y}`}
                className={cn(colorClass, "rounded-xs opacity-50")}
                style={{
                  position: "absolute",
                  left,
                  top,
                  width,
                  height,
                }}
              />
            );
          }),
      )}
    </div>
  );
};
