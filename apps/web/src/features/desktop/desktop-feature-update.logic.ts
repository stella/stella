import type { ChatLocalRunReadiness } from "@stll/api-contract/chat-run-target";
import {
  DESKTOP_FEATURE_MINIMUM_VERSIONS,
  DESKTOP_WORKSPACE_VERSION,
  type DesktopFeature,
  releaseVersionIsBelow,
} from "@stll/api-contract/desktop-presence";

import type { TranslationKey } from "@/i18n/types";

/**
 * What the web says when a chat on the member's computer needs a newer stella
 * desktop for a feature.
 */
export const DESKTOP_FEATURE_UPDATE_MESSAGES = {
  browserSiteApprovals: "chat.desktopUpdate.browserSiteApprovals",
} as const satisfies Record<DesktopFeature, TranslationKey>;

/**
 * The link that asks stella desktop on this computer to check for an update
 * now. The desktop runs its normal check: it downloads a newer release, then
 * installs it once nothing on the computer still needs the running app.
 */
export const DESKTOP_UPDATE_CHECK_URL = "stella://ping";

/**
 * Whether a chat on the member's computer runs on a stella desktop too old
 * for `feature`: every computer connected now is below the release that
 * brought it. With none connected, or one already new enough that a run may
 * land on (a build made from a checkout counts as new enough), there is
 * nothing to update for.
 */
export const desktopNeedsUpdateFor = (
  feature: DesktopFeature,
  readiness: ChatLocalRunReadiness | undefined,
): boolean => {
  if (readiness?.status !== "enabled") {
    return false;
  }
  const connected = readiness.runners.filter((runner) => runner.connected);
  return (
    connected.length > 0 &&
    connected.every(
      (runner) =>
        runner.appVersion !== DESKTOP_WORKSPACE_VERSION &&
        releaseVersionIsBelow(
          runner.appVersion,
          DESKTOP_FEATURE_MINIMUM_VERSIONS[feature],
        ),
    )
  );
};
