import { FaceLabelPending } from "@stll/ui/control-face";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import {
  MATTER_CARD_GRID_CLASS,
  MATTER_CARD_PENDING_KEYS,
  MatterCardSkeleton,
} from "@/routes/_protected.workspaces/-components/matter-card.pending";

/** One client's matters: a row of the grid that lays its cards on the grid. */
export const CLIENT_GROUP_SECTION_CLASS =
  "group/client-section col-span-full grid auto-rows-min gap-3 rounded-xl md:grid-cols-subgrid";

/** The group's header, a plain button across the grid, sticky over the cards. */
const CLIENT_GROUP_HEADER_CLASS = "sticky top-0 z-10 col-span-full flex";

/** The sticky band the matters scroll under. */
export const CLIENT_GROUP_BAND_CLASS = cn(
  "flex w-full items-center gap-2",
  "bg-background/95 border-b backdrop-blur-sm",
  "pt-4 pb-2 group-first/client-section:pt-0",
);

/** The group's expand chevron; it turns down while the group is open. */
const CLIENT_GROUP_CHEVRON_CLASS =
  "text-muted-foreground size-3.5 shrink-0 transition-transform";

/** The group's name. */
export const CLIENT_GROUP_TITLE_CLASS = "text-sm font-semibold";

/** The pill with how many matters the group holds. */
export const CLIENT_GROUP_COUNT_CLASS = cn(
  "bg-muted rounded-full px-1.5 py-0.5",
  "text-muted-foreground text-3xs tabular-nums",
);

/** Placeholder groups while the matters load. */
const CLIENT_GROUP_PENDING_KEYS = MATTER_CARD_PENDING_KEYS.slice(0, 2);

/** Placeholder cards per group. */
const CLIENT_GROUP_PENDING_CARDS = MATTER_CARD_PENDING_KEYS.slice(0, 3);

/**
 * The grid grouped by client while the matters load: open groups whose
 * name and count wait on the data, each over placeholder cards that do not
 * name their client (the group does).
 */
export const ClientGroupSectionsPending = () => (
  <div aria-hidden="true" className={MATTER_CARD_GRID_CLASS}>
    {CLIENT_GROUP_PENDING_KEYS.map((groupKey) => (
      <div className={CLIENT_GROUP_SECTION_CLASS} key={groupKey}>
        <span
          className={cn(
            "relative max-w-full text-start",
            CLIENT_GROUP_HEADER_CLASS,
          )}
        >
          <span className={CLIENT_GROUP_BAND_CLASS}>
            <DirectionalIcon
              className={cn(CLIENT_GROUP_CHEVRON_CLASS, "rotate-90")}
              flip={false}
              icon={ChevronRightIcon}
            />
            <span className={CLIENT_GROUP_TITLE_CLASS}>
              <FaceLabelPending className="w-28" />
            </span>
            <span className={CLIENT_GROUP_COUNT_CLASS}>
              <FaceLabelPending className="w-2" />
            </span>
          </span>
        </span>
        {CLIENT_GROUP_PENDING_CARDS.map((cardKey) => (
          <MatterCardSkeleton hideClientName key={cardKey} />
        ))}
      </div>
    ))}
  </div>
);
