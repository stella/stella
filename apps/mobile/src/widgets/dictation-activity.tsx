import type { LiveActivityFactory } from "expo-widgets";

import type { DictationActivityProps } from "@/state/quick-dictation";

/** Live Activities are iOS's; elsewhere there is none to register. */
export const DictationActivity: LiveActivityFactory<DictationActivityProps> | null =
  null;
