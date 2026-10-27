import { ArrowDownIcon, ArrowUpIcon } from "@stll/ui/icons";
import { StellaMark } from "@stll/ui/stella-mark";
import { cn } from "@stll/ui/utils";

import type { TrayLocation } from "./onboarding-types";

/** Neighbouring status icons, as offsets along the bar from the app's. */
const NEIGHBOURS = [-0.15, -0.1, -0.05, 0.05, 0.1] as const;

/** Keeps the highlighted icon and its pointer inside the drawing. */
const MARGIN = 0.06;

/**
 * A small drawing of the screen with the menu bar (or the taskbar) and the
 * app's icon highlighted where the OS reports it, so the last step shows
 * where to find the app instead of only naming the place. A bar on the
 * left or right of the screen is drawn along the nearer of top and bottom.
 */
export const TrayLocationPreview = ({
  location,
}: {
  location: TrayLocation;
}) => {
  const bottom = location.edge === "bottom";
  const along = Math.min(1 - MARGIN, Math.max(MARGIN, location.along));
  const bar = (
    <div
      className={cn(
        "bg-muted relative h-7 shrink-0",
        bottom ? "border-t" : "border-b",
      )}
      data-tray-bar=""
    >
      {NEIGHBOURS.map((offset) => along + offset)
        .filter((position) => position > 0.03 && position < 0.97)
        .map((position) => (
          <span
            aria-hidden="true"
            className="bg-foreground/20 absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-sm"
            key={position}
            style={{ insetInlineStart: `${position * 100}%` }}
          />
        ))}
      <span
        className="bg-background ring-primary text-foreground absolute top-1/2 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-md shadow-sm ring-2"
        data-tray-icon=""
        style={{ insetInlineStart: `${along * 100}%` }}
      >
        <StellaMark className="size-3.5" />
      </span>
    </div>
  );
  const pointer = (
    <div className="relative h-8">
      <span
        className={cn(
          "text-primary absolute -translate-x-1/2",
          bottom ? "bottom-1" : "top-1",
        )}
        style={{ insetInlineStart: `${along * 100}%` }}
      >
        {bottom ? (
          <ArrowDownIcon className="size-5" />
        ) : (
          <ArrowUpIcon className="size-5" />
        )}
      </span>
    </div>
  );
  // The drawing follows the screen, which is laid out left to right in
  // every language.
  return (
    <div
      aria-hidden="true"
      className="bg-card flex w-full max-w-md flex-col overflow-hidden rounded-xl border shadow-xs"
      dir="ltr"
    >
      {bottom ? null : bar}
      <div
        className={cn(
          "flex h-20 flex-col",
          bottom ? "justify-end" : "justify-start",
        )}
      >
        {pointer}
      </div>
      {bottom ? bar : null}
    </div>
  );
};
