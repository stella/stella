import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { DesktopFeature } from "@stll/api-contract/desktop-presence";
import { Button } from "@stll/ui/button";

import { localRunnersOptions } from "@/features/chat/queries";
import { openDesktopUrl } from "@/lib/desktop-bridge";
import { queryView } from "@/lib/query-view.logic";

import {
  DESKTOP_FEATURE_UPDATE_MESSAGES,
  DESKTOP_UPDATE_CHECK_URL,
  desktopNeedsUpdateFor,
} from "./desktop-feature-update.logic";

/**
 * Says that a chat on the member's computer runs on a stella desktop too old
 * for `feature`, with the one action that fixes it: asking that desktop to
 * check for an update now. Renders nothing when the desktop is new enough.
 */
export const DesktopFeatureUpdateNotice = ({
  activeOrganizationId,
  feature,
}: {
  activeOrganizationId: string;
  feature: DesktopFeature;
}) => {
  const t = useTranslations();
  // Until the computers are read, or when they cannot be, nothing is
  // known to need an update: the card keeps its own actions either way.
  const runners = queryView(
    useQuery(localRunnersOptions(activeOrganizationId)),
  );
  if (
    runners.type !== "items" ||
    !desktopNeedsUpdateFor(feature, runners.items)
  ) {
    return null;
  }
  return (
    <div className="border-border/50 flex flex-wrap items-center gap-2 border-t px-3 py-2">
      <p className="text-muted-foreground min-w-0 flex-1 text-xs">
        {t(DESKTOP_FEATURE_UPDATE_MESSAGES[feature])}
      </p>
      <Button
        onClick={() => {
          openDesktopUrl(DESKTOP_UPDATE_CHECK_URL);
        }}
        size="xs"
        variant="outline"
      >
        {t("workspaces.files.desktopGate.update")}
      </Button>
    </div>
  );
};
