import { getRouteApi } from "@tanstack/react-router";

import { todayIn } from "@/components/billing/work-week.logic";
import { MyWeek } from "@/features/my-week/my-week";
import { detached } from "@/lib/detached";

import { MyWeekShell } from "./-my-week.pending";

const routeApi = getRouteApi("/_protected/time");

export function MyWeekPage() {
  const searchDate = routeApi.useSearch({ select: (search) => search.date });
  const { organizationId, userId, timezoneId } = routeApi.useRouteContext({
    select: (context) => ({
      organizationId: context.user.activeOrganizationId,
      userId: context.user.id,
      timezoneId: context.user.timezoneId,
    }),
  });
  const navigate = routeApi.useNavigate();

  return (
    <MyWeekShell>
      <MyWeek
        date={searchDate ?? todayIn(timezoneId)}
        onSelectDate={(date) =>
          detached(navigate({ search: { date } }), "my-week.navigate")
        }
        onToday={() => detached(navigate({ search: {} }), "my-week.today")}
        organizationId={organizationId}
        timezoneId={timezoneId}
        userId={userId}
      />
    </MyWeekShell>
  );
}
