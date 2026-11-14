import { envBase } from "@/api/env-base";
import { isLocalDevOpen } from "@/api/runtime-mode";

/**
 * Kill-switch overrides shared by every entrypoint that admits model work:
 * the API server, its workers, and base-environment processes. Read per
 * admission; tests and open local development replace the overrides here.
 */
export const envKillSwitches = {
  KILL_SWITCHES: envBase.KILL_SWITCHES,
};
if (!isLocalDevOpen()) {
  Object.freeze(envKillSwitches);
}
