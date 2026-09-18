import type { TSchema } from "@sinclair/typebox";
import { t } from "elysia";

import { SIGNAL_VIEW } from "@stll/api-contract/signals";
import type { SignalView } from "@stll/api-contract/signals";

const SIGNAL_VIEW_SCHEMAS = {
  [SIGNAL_VIEW.OPEN]: t.Literal(SIGNAL_VIEW.OPEN),
  [SIGNAL_VIEW.SNOOZED]: t.Literal(SIGNAL_VIEW.SNOOZED),
  [SIGNAL_VIEW.RESOLVED]: t.Literal(SIGNAL_VIEW.RESOLVED),
} as const satisfies Record<SignalView, TSchema>;

/** The Inbox lifecycle views, shared by the signal list and the views window. */
export const signalViewSchema = t.Union([
  SIGNAL_VIEW_SCHEMAS.open,
  SIGNAL_VIEW_SCHEMAS.snoozed,
  SIGNAL_VIEW_SCHEMAS.resolved,
]);
