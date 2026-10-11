import { useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { ScanCornerSuggestion, ScanQuad } from "@stll/scan-engine/types";
import { Button } from "@stll/ui/button";

import { useBoxDrag } from "@/hooks/use-box-drag";
import type { BoxDragAdjustment } from "@/hooks/use-box-drag";
import type { TranslationKey } from "@/i18n/types";

import {
  dragScanCorner,
  fullPageScanCorners,
  moveScanCorner,
} from "./page-organizer-scan-corners.logic";
import type { ScanCorner } from "./page-organizer-scan-corners.logic";

const CORNER_LABELS = {
  topLeft: "workspaces.pdf.pageEditor.scanCornerTopLeft",
  topRight: "workspaces.pdf.pageEditor.scanCornerTopRight",
  bottomRight: "workspaces.pdf.pageEditor.scanCornerBottomRight",
  bottomLeft: "workspaces.pdf.pageEditor.scanCornerBottomLeft",
} as const satisfies Record<ScanCorner, TranslationKey>;

const isScanCorner = (key: string): key is ScanCorner =>
  Object.hasOwn(CORNER_LABELS, key);

type PageOrganizerScanCornersProps = {
  width: number;
  height: number;
  imageUrl: string;
  suggestion: ScanCornerSuggestion;
  onChange: (corners: ScanQuad) => void;
};

/** Remount with the page identity when the source raster changes. */
export const PageOrganizerScanCorners = ({
  width,
  height,
  imageUrl,
  suggestion,
  onChange,
}: PageOrganizerScanCornersProps) => {
  const t = useTranslations();
  const instructionsId = useId();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [corners, setCorners] = useState(suggestion.corners);
  const changeCorners = (next: ScanQuad) => {
    setCorners(next);
    onChange(next);
  };
  const { startDrag, ...dragHandlers } = useBoxDrag({
    box: corners,
    adjust: (adjustment: BoxDragAdjustment<ScanQuad, ScanCorner>) =>
      dragScanCorner({ ...adjustment, width, height }),
    onChange: changeCorners,
  });
  const nudgeCorner = (
    event: KeyboardEvent<HTMLElement>,
    corner: ScanCorner,
  ) => {
    const step = event.shiftKey ? 10 : 1;
    let delta;
    switch (event.key) {
      case "ArrowLeft":
        delta = { x: -step, y: 0 };
        break;
      case "ArrowRight":
        delta = { x: step, y: 0 };
        break;
      case "ArrowUp":
        delta = { x: 0, y: -step };
        break;
      case "ArrowDown":
        delta = { x: 0, y: step };
        break;
      default:
        return;
    }
    event.preventDefault();
    changeCorners(moveScanCorner({ corners, corner, delta, width, height }));
  };

  return (
    <div className="space-y-3">
      <p id={instructionsId} className="text-muted-foreground text-sm">
        {t("workspaces.pdf.pageEditor.scanCornersInstructions")}
      </p>
      {suggestion.type === "full-frame" && (
        <p role="status" className="text-muted-foreground text-sm">
          {t("workspaces.pdf.pageEditor.scanFullPageFallback")}
        </p>
      )}
      <div ref={surfaceRef} className="relative mx-4">
        <img
          src={imageUrl}
          alt=""
          width={width}
          height={height}
          className="outline-border block h-auto w-full outline-1"
          draggable={false}
        />
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${width - 1} ${height - 1}`}
          preserveAspectRatio="none"
        >
          <polygon
            points={[
              corners.topLeft,
              corners.topRight,
              corners.bottomRight,
              corners.bottomLeft,
            ]
              .map(({ x, y }) => `${x},${y}`)
              .join(" ")}
            className="stroke-primary fill-transparent"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {Object.entries(CORNER_LABELS).map(([corner, label]) => {
          if (!isScanCorner(corner)) {
            return panic("Unknown scan corner");
          }
          return (
            <Button
              key={corner}
              type="button"
              variant="outline"
              size="icon"
              className="absolute size-11 cursor-move touch-none"
              aria-label={t(label)}
              aria-describedby={instructionsId}
              style={{
                left: `${(corners[corner].x / (width - 1)) * 100}%`,
                top: `${(corners[corner].y / (height - 1)) * 100}%`,
                transform: "translate(-50%, -50%)",
              }}
              onPointerDown={(event) => {
                if (surfaceRef.current) {
                  startDrag(event, {
                    mode: corner,
                    surface: surfaceRef.current,
                  });
                }
              }}
              onKeyDown={(event) => nudgeCorner(event, corner)}
              {...dragHandlers}
            />
          );
        })}
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={() => changeCorners(fullPageScanCorners(width, height))}
      >
        {t("workspaces.pdf.pageEditor.scanUseFullPage")}
      </Button>
    </div>
  );
};
