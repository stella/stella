import * as v from "valibot";

import { APP_PROVISION_HISTORY_SCHEMA } from "../shared/generated/contracts";

export type StatuteTimelineHistory = v.InferOutput<
  typeof APP_PROVISION_HISTORY_SCHEMA
>;
export type ProvisionVersion = StatuteTimelineHistory["items"][number];

export const parseStatuteTimelineHistory = (payload: unknown) => {
  const parsed = v.safeParse(APP_PROVISION_HISTORY_SCHEMA, payload);
  return parsed.success ? parsed.output : undefined;
};
