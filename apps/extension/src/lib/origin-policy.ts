import { createOriginPolicy } from "@stll/browser-page/origin-policy";

import { STELLA_HOSTNAMES, trustedStellaOriginFromUrl } from "./trusted-origin";

/** The origin policy with the stella origins this build knows. */
export const { isControllableFrame, parseControllableUrl } = createOriginPolicy(
  {
    hostnames: STELLA_HOSTNAMES,
    originFromUrl: trustedStellaOriginFromUrl,
  },
);
