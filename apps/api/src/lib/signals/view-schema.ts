import * as v from "valibot";

import { SIGNAL_VIEW } from "@stll/api-contract/signals";
import type { SignalView } from "@stll/api-contract/signals";

const SIGNAL_VIEW_SCHEMAS = {
  [SIGNAL_VIEW.OPEN]: v.literal(SIGNAL_VIEW.OPEN),
  [SIGNAL_VIEW.SNOOZED]: v.literal(SIGNAL_VIEW.SNOOZED),
  [SIGNAL_VIEW.RESOLVED]: v.literal(SIGNAL_VIEW.RESOLVED),
} as const satisfies Record<SignalView, v.GenericSchema>;

/** The Inbox lifecycle views, shared by the signal list and the views window. */
export const signalViewSchema = v.union([
  SIGNAL_VIEW_SCHEMAS.open,
  SIGNAL_VIEW_SCHEMAS.snoozed,
  SIGNAL_VIEW_SCHEMAS.resolved,
]);
