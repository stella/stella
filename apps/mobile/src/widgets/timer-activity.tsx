import type { LiveActivityFactory } from "expo-widgets";

import type { TimerActivityProps } from "@/state/timer-activity";

/** Live Activities are iOS's; elsewhere there is none to start. */
export const TimerActivity: LiveActivityFactory<TimerActivityProps> | null =
  null;
