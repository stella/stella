import { env } from "@/api/env";

/** Whether this deployment serves legal lists; local development always does. */
export const legalListsDeployed = (): boolean =>
  env.isDev || env.FEATURE_LEGAL_LISTS;
