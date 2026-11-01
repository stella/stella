import { env } from "@/api/env";

import { reviewOrganizationConfigFrom } from "./config";

/** Read the optional identity used by the scheduled reset. */
export const readReviewOrganizationConfig = () =>
  reviewOrganizationConfigFrom(env);
