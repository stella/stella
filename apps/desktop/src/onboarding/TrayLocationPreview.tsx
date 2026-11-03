import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
} from "@stll/ui/icons";
import { StellaMark } from "@stll/ui/stella-mark";
import { cn } from "@stll/ui/utils";

import type { TrayLocation } from "./onboarding-types";

/** Neighbouring status icons, as offsets along the bar from the app's. */
const NEIGHBOURS = [-0.15, -0.1, -0.05, 0.05, 0.1] as const;

/** Keeps the highlighted icon and its pointer inside the drawing. */
const MARGIN = 0.06;

type EdgeLayout = {
  axis: "horizontal" | "vertical";
  bar: string;
  pointer: string;
  Icon: typeof ArrowUpIcon;
};

const EDGE_LAYOUTS = {
  top: {
    axis: "horizontal",
    bar: "inset-x-0 top-0 h-7 border-b",
    pointer: "top-8",
    Icon: ArrowUpIcon,
  },
  bottom: {
    axis: "horizontal",
    bar: "inset-x-0 bottom-0 h-7 border-t",
    pointer: "bottom-8",
    Icon: ArrowDownIcon,
  },
  left: {
    axis: "vertical",
    bar: "inset-y-0 start-0 w-7 border-e",
    pointer: "start-8",
    Icon: ArrowLeftIcon,
  },
  right: {
    axis: "vertical",
    bar: "inset-y-0 end-0 w-7 border-s",
    pointer: "end-8",
    Icon: ArrowRightIcon,
  },
} as const satisfies Record<TrayLocation["edge"], EdgeLayout>;

/**
 * A small drawing of the screen with the menu bar (or the taskbar) and the
 * app's icon highlighted where the OS reports it, so the last step shows
 * where to find the app instead of only naming the place.
 */
export const TrayLocationPreview = ({
  location,
}: {
  location: TrayLocation;
}) => {
  const layout = EDGE_LAYOUTS[location.edge];
  const { Icon } = layout;
  const vertical = layout.axis === "vertical";
  const along = Math.min(1 - MARGIN, Math.max(MARGIN, location.along));
  const placeAlong = (value: string) =>
    vertical ? { insetBlockStart: value } : { insetInlineStart: value };
  // Short vertical bars still need room for the highlighted icon and ring.
  const highlightedPosition = placeAlong(
    `clamp(1rem, ${along * 100}%, calc(100% - 1rem))`,
  );
  const bar = (
    <div className={cn("bg-muted absolute", layout.bar)} data-tray-bar="">
      {NEIGHBOURS.map((offset) => along + offset)
        .filter((position) => position > 0.03 && position < 0.97)
        .map((position) => (
          <span
            aria-hidden="true"
            className={cn(
              "bg-foreground/20 absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-sm",
              vertical ? "start-1/2" : "top-1/2",
            )}
            key={position}
            style={placeAlong(`${position * 100}%`)}
          />
        ))}
      <span
        className={cn(
          "bg-background ring-primary text-foreground absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-md shadow-sm ring-2",
          vertical ? "start-1/2" : "top-1/2",
        )}
        data-tray-icon=""
        style={highlightedPosition}
      >
        <StellaMark className="size-3.5" />
      </span>
    </div>
  );
  // The drawing follows the screen, which is laid out left to right in
  // every language.
  return (
    <div
      aria-hidden="true"
      className="bg-card relative h-28 w-full max-w-md overflow-hidden rounded-xl border shadow-xs"
      dir="ltr"
    >
      {bar}
      <span
        className={cn(
          "text-primary absolute",
          layout.pointer,
          vertical ? "-translate-y-1/2" : "-translate-x-1/2",
        )}
        data-tray-pointer=""
        style={highlightedPosition}
      >
        <Icon className="size-5" />
      </span>
    </div>
  );
};
