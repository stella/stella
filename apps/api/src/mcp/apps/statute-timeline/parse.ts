import * as v from "valibot";

import { READ_PROVISION_HISTORY_PROJECTION } from "../../../lib/chat/legislation-result-projections";

export type ProvisionHistory = v.InferOutput<
  typeof READ_PROVISION_HISTORY_PROJECTION
>;
export type ProvisionVersion = ProvisionHistory["items"][number];

export const parseHistory = (payload: unknown) => {
  const parsed = v.safeParse(READ_PROVISION_HISTORY_PROJECTION, payload);
  return parsed.success ? parsed.output : undefined;
};
