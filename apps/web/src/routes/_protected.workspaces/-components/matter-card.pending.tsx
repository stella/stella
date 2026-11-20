import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

/** The matters grid: three cards a row from `md`, one below. */
export const MATTER_CARD_GRID_CLASS = "grid auto-rows-min gap-3 md:grid-cols-3";

/** A matter card's box, which `MatterCard` and its placeholder share. */
export const MATTER_CARD_CLASS =
  "bg-card relative isolate flex flex-col gap-1 overflow-hidden rounded-xl border px-3 py-2";

/** The card's first line: the matter's name and its reference. */
export const MATTER_CARD_TITLE_ROW_CLASS = "flex items-center gap-2";

/** The card's last line: items and deadline, then team and last activity. */
export const MATTER_CARD_META_ROW_CLASS =
  "flex items-center justify-between gap-2 text-xs";

/** A bar on one line of the card's text, at that line's height. */
const CardLineBar = ({
  className,
  lineClassName,
}: {
  className: string;
  lineClassName: string;
}) => (
  <span className={cn("flex items-center", lineClassName)}>
    <Skeleton className={cn("h-3", className)} />
  </span>
);

/**
 * A matter card while the matters load: the card's box with its lines at
 * their heights (the name, the client unless the grid is grouped by client,
 * then items on the start and the team and last activity on the end).
 */
export const MatterCardSkeleton = ({
  hideClientName,
}: {
  /** The grid is grouped by client, so the card does not name its client. */
  hideClientName: boolean;
}) => (
  <div aria-hidden="true" className={MATTER_CARD_CLASS}>
    <div className={MATTER_CARD_TITLE_ROW_CLASS}>
      <CardLineBar className="w-3/5" lineClassName="h-5 min-w-0 flex-1" />
      <CardLineBar className="w-12" lineClassName="h-4 shrink-0" />
    </div>
    {hideClientName ? null : (
      <CardLineBar className="w-24" lineClassName="-mt-1 h-4" />
    )}
    <div className={MATTER_CARD_META_ROW_CLASS}>
      <CardLineBar className="w-20" lineClassName="h-5 min-w-0" />
      <div className="flex shrink-0 items-center gap-2">
        <div className="flex items-center -space-x-1">
          <Skeleton className="size-5 rounded-full" />
          <Skeleton className="size-5 rounded-full" />
        </div>
        <CardLineBar className="w-10" lineClassName="h-4" />
      </div>
    </div>
  </div>
);

/** Placeholder cards, about a screen of them. */
export const MATTER_CARD_PENDING_KEYS = Array.from(
  { length: 6 },
  (_, slot) => `card-${String(slot)}`,
);

/** The flat matters grid while the matters load. */
export const MatterCardGridPending = () => (
  <div aria-hidden="true" className={MATTER_CARD_GRID_CLASS}>
    {MATTER_CARD_PENDING_KEYS.map((key) => (
      <MatterCardSkeleton hideClientName={false} key={key} />
    ))}
  </div>
);
