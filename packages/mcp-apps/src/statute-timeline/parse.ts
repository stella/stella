import * as v from "valibot";

import { APP_PROVISION_HISTORY_SCHEMA } from "../shared/generated/contracts";

export type ProvisionHistory = v.InferOutput<
  typeof APP_PROVISION_HISTORY_SCHEMA
>;
export type ProvisionVersion = ProvisionHistory["items"][number];

export const parseHistory = (payload: unknown) => {
  const parsed = v.safeParse(APP_PROVISION_HISTORY_SCHEMA, payload);
  return parsed.success ? parsed.output : undefined;
};
