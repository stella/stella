import { env } from "@/api/env";
import { isLocalDevOpen } from "@/api/runtime-mode";

/** Whether the public legal-corpus routes are served in this deployment. */
export const isPublicLawEnabled = (): boolean =>
  isLocalDevOpen() || env.FEATURE_PUBLIC_LAW;
