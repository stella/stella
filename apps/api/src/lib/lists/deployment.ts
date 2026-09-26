import { env } from "@/api/env";
import { isLocalDevOpen } from "@/api/runtime-mode";

/** Whether this deployment serves legal lists; local development always does. */
export const legalListsDeployed = (): boolean =>
  isLocalDevOpen() || env.FEATURE_LEGAL_LISTS;
