import { env } from "@/api/env";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { isLocalDevOpen } from "@/api/runtime-mode";

export const isPublicLawEnabled = (): boolean =>
  isLocalDevOpen() || env.FEATURE_PUBLIC_LAW;

/** The one gate every public legal-corpus route family mounts. */
export const publicLawFeatureGate = deploymentFeatureGate(isPublicLawEnabled);
