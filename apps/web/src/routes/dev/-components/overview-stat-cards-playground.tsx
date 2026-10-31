import { CalendarClockIcon, SquareCheckIcon } from "@stll/ui/icons";

import { StatCard } from "@/routes/_protected.workspaces/$workspaceId/-components/overview-view";

const LONG_TASK_NAME =
  "Podať námietky v podateľni úradu a doručiť rovnopis kontrolovanému subjektu pred uplynutím zákonnej lehoty";

/**
 * The matter overview's stat cards with a long task name under the deadline,
 * in the narrow one-column grid and the wide four-column one, as a link card
 * and as a static one: the name must end in an ellipsis inside the card.
 */
export const OverviewStatCardsPlayground = () => (
  <div className="flex flex-col gap-6 p-4" data-playground-section="overview">
    {[320, 960].map((width) => (
      <div className="@container" key={width} style={{ width }}>
        <div className="grid gap-3 @sm:grid-cols-2 @3xl:grid-cols-4">
          <StatCard
            icon={<CalendarClockIcon className="size-4" />}
            label="workspaces.overview.nextDeadline"
            onClick={() => undefined}
            sublabel={LONG_TASK_NAME}
            value="15. 1. 2030"
          />
          <StatCard
            icon={<CalendarClockIcon className="size-4" />}
            label="workspaces.overview.nextDeadline"
            sublabel={LONG_TASK_NAME}
            value="15. 1. 2030"
          />
          <StatCard
            icon={<SquareCheckIcon className="size-4" />}
            label="workspaces.overview.openTasks"
            value="12"
          />
        </div>
      </div>
    ))}
  </div>
);
