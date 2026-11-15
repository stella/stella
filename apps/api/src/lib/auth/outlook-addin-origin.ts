import { outlookRedirectUri } from "@stll/api-contract/outlook-client";

import { env } from "@/api/env";

/**
 * The Outlook add-in's OAuth callback on this deployment's task-pane origin,
 * or undefined when the deployment configures none.
 */
export const getOutlookAddinRedirectUri = (): string | undefined =>
  env.OUTLOOK_ADDIN_ORIGIN === undefined
    ? undefined
    : outlookRedirectUri(env.OUTLOOK_ADDIN_ORIGIN);
