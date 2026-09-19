import {
  FoldHorizontalIcon,
  MinusIcon,
  PlusIcon,
  UnfoldHorizontalIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

export type ZoomDirection = "in" | "out";

type ZoomControlsProps = {
  /** The surface is already at its largest step; growing is refused. */
  atMax?: boolean | undefined;
  /** The surface is already at its smallest step; shrinking is refused. */
  atMin?: boolean | undefined;
  /**
   * The current level as a multiple of the surface's own default, where 1 is
   * that default. It decides whether there is anything to reset and which way
   * the reset points.
   */
  level: number;
  onReset: () => void;
  onZoom: (direction: ZoomDirection) => void;
};

const DEFAULT_LEVEL = 1;

/**
 * The minus / plus / reset triad every inspector surface zooms with: the PDF
 * and DOCX viewers, and the readers, which step their text size instead of a
 * page scale. One control so the gesture, the icons and the labels are the
 * same wherever something can be made bigger.
 */
export const ZoomControls = ({
  atMax = false,
  atMin = false,
  level,
  onReset,
  onZoom,
}: ZoomControlsProps) => {
  const t = useTranslations();

  return (
    <>
      <Button
        disabled={atMin}
        onClick={() => onZoom("out")}
        size="icon-xs"
        tooltip={t("common.zoomOut")}
        variant="ghost"
      >
        <MinusIcon className="size-3" />
      </Button>
      <Button
        disabled={atMax}
        onClick={() => onZoom("in")}
        size="icon-xs"
        tooltip={t("common.zoomIn")}
        variant="ghost"
      >
        <PlusIcon className="size-3" />
      </Button>
      <Button
        disabled={level === DEFAULT_LEVEL}
        onClick={onReset}
        size="icon-xs"
        tooltip={t("common.resetZoom")}
        variant="ghost"
      >
        {level > DEFAULT_LEVEL ? (
          <FoldHorizontalIcon className="size-3" />
        ) : (
          <UnfoldHorizontalIcon className="size-3" />
        )}
      </Button>
    </>
  );
};
