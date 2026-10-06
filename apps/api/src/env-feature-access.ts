import { envBase } from "@/api/env-base";
import { isLocalDevOpen } from "@/api/runtime-mode";

/** Grant configuration shared by every authenticated database entrypoint. */
export const envFeatureAccess = {
  API_FEATURE_ACCESS_GRANTS: envBase.API_FEATURE_ACCESS_GRANTS,
};
if (!isLocalDevOpen()) {
  Object.freeze(envFeatureAccess);
}
