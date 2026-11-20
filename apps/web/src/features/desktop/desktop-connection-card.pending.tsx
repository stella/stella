import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { Frame, FramePanel } from "@stll/ui/frame";
import { cn } from "@stll/ui/utils";

/** The state tile's box; the card adds its tone. */
export const DESKTOP_CARD_TILE_CLASS =
  "grid size-11 shrink-0 place-items-center rounded-2xl";

type DesktopConnectionCardFrameProps = {
  /** The tile showing the link's state. */
  tile: ReactNode;
  title: ReactNode;
  detail: ReactNode;
  /** The one action that moves the link forward. */
  actions: ReactNode;
  /** What follows the row (the download buttons while nothing is set up). */
  children?: ReactNode;
};

/**
 * The desktop link card's layout (`DesktopConnectionCard`), in both phases:
 * the state tile, the title and its line, the action, then the setup row.
 */
export const DesktopConnectionCardFrame = ({
  actions,
  children,
  detail,
  tile,
  title,
}: DesktopConnectionCardFrameProps) => (
  <Frame>
    <FramePanel>
      <div className="flex flex-col gap-4 p-1 sm:flex-row sm:items-center">
        {tile}
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-balance">{title}</h2>
          <p className="text-muted-foreground mt-1 text-sm text-pretty">
            {detail}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      </div>
      {children}
    </FramePanel>
  </Frame>
);

/**
 * The card before this computer and the account's link are read: the tile,
 * a bar on each line and the action's face (which state it is in, and so
 * which words and which action, waits on those reads).
 */
export const DesktopConnectionCardPending = () => (
  <DesktopConnectionCardFrame
    actions={
      <ButtonFace size="default" variant="outline">
        <FaceLabelPending className="w-24" />
      </ButtonFace>
    }
    detail={<FaceLabelPending className="w-72 max-w-full" />}
    tile={
      <span
        aria-hidden="true"
        className={cn(DESKTOP_CARD_TILE_CLASS, "bg-muted")}
      />
    }
    title={<FaceLabelPending className="w-40" />}
  />
);
