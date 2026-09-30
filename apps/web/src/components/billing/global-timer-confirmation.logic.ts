import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

export const timerActivityOptions = (matterId: string | null) =>
  matterId === null
    ? ({
        defaultActivityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
        activityGroups: [
          TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
          TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
        ],
      } as const)
    : ({
        defaultActivityGroup: TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
        activityGroups: [TIME_ENTRY_ACTIVITY_GROUP.CLIENT],
      } as const);
