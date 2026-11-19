import {
  CalendarClockIcon,
  FolderTreeIcon,
  SquareCheckIcon,
} from "@stll/ui/icons";

import { StatCardPending } from "@/components/overview-stat-card.pending";

/** The overview's page: its own scroll column, sized to the view's body. */
export const OVERVIEW_VIEW_CLASS =
  "@container flex flex-1 flex-col gap-6 overflow-y-auto p-4 tabular-nums sm:p-6";

/** The row of stat cards at the top of the overview. */
export const OVERVIEW_STATS_GRID_CLASS =
  "grid gap-3 @sm:grid-cols-2 @3xl:grid-cols-4";

/**
 * The overview before its data: the page's column and the stat cards every
 * matter has (documents, open tasks, next deadline) with bars where their
 * numbers go. The cards a feature or a permission adds, and the panels below,
 * depend on reads still in flight, so they are not drawn until they load:
 * they join after the cards, and nothing above them moves.
 */
export const OverviewViewPending = () => (
  <div aria-hidden="true" className={OVERVIEW_VIEW_CLASS}>
    <div className={OVERVIEW_STATS_GRID_CLASS}>
      <StatCardPending
        icon={<FolderTreeIcon className="size-4" />}
        label="workspaces.overview.totalDocuments"
      />
      <StatCardPending
        icon={<SquareCheckIcon className="size-4" />}
        label="workspaces.overview.openTasks"
      />
      <StatCardPending
        icon={<CalendarClockIcon className="size-4" />}
        label="workspaces.overview.nextDeadline"
      />
    </div>
  </div>
);
