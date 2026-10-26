import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Frame, FramePanel } from "@stll/ui/frame";
import {
  CircleCheckIcon,
  LaptopIcon,
  LinkIcon,
  TriangleAlertIcon,
} from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { DesktopDownloadButtons } from "@/components/desktop-download-buttons";
import {
  desktopCardState,
  offersDesktopSetup,
} from "@/features/desktop/desktop-connection-card.logic";
import type { DesktopCardState } from "@/features/desktop/desktop-connection-card.logic";
import { DesktopConnectionStatus } from "@/features/desktop/desktop-connection-status";
import { desktopPresenceOptions } from "@/features/desktop/desktop-presence";
import { useDesktopAccountConnection } from "@/features/desktop/use-desktop-account-connection";
import { useMountEffect } from "@/hooks/use-effect";
import { useHydrationSafeDesktopPlatform } from "@/hooks/use-hydration-safe-desktop-platform";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import {
  captureDesktopAccountLink,
  hasDesktopAccountChallenge,
} from "@/lib/desktop-bridge";
import { detached } from "@/lib/detached";
import { notifyUserProblem } from "@/lib/errors/user-toast";
import { useQueryView } from "@/lib/use-query-view";

const serverHost = () => window.location.host;

/**
 * The one place a person links stella desktop: it says what was found on
 * this computer, which account and server a link would use, and offers the
 * single action that moves it forward.
 */
export const DesktopConnectionCard = () => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const platform = useHydrationSafeDesktopPlatform();
  const { connect, state: connection } = useDesktopAccountConnection();
  const presenceQuery = useQuery(
    desktopPresenceOptions({
      userId: user.id,
      organizationId: user.activeOrganizationId,
    }),
  );
  const presenceView = useQueryView(presenceQuery);
  // An unreadable record never claims a link; the card falls back to what it
  // can see on this computer.
  const presence =
    presenceView.type === "items" ? presenceView.items : undefined;
  const [challengeWaiting, setChallengeWaiting] = useState(false);
  const [host, setHost] = useState("");

  // Capture the native challenge and remove its secret from browser history.
  // Linking still requires the button's explicit user gesture.
  useMountEffect(() => {
    captureDesktopAccountLink();
    setChallengeWaiting(hasDesktopAccountChallenge());
    setHost(serverHost());
  });

  const card =
    connection.status === "connected"
      ? ({ type: "connected", version: "", onThisComputer: true } as const)
      : desktopCardState({
          challengeWaiting,
          presence,
        });

  const handleConnect = async () => {
    const outcome = await connect();
    // A failed approval keeps a challenge that is still valid; an expired or
    // consumed one falls back to the install-or-connect offer.
    setChallengeWaiting(hasDesktopAccountChallenge());
    if (outcome.status === "started" || outcome.status === "update-required") {
      return;
    }
    if (outcome.status === "connected") {
      stellaToast.add({ title: t("common.done"), type: "success" });
      detached(
        presenceQuery.refetch(),
        "settings-account-desktop.refresh-presence",
      );
      return;
    }
    notifyUserProblem(t("errors.actionFailed"));
  };
  const onConnect = () => {
    detached(handleConnect(), "settings-account-desktop.connect-desktop");
  };

  const copy = cardCopy(card);
  const identity =
    user.preferredName?.trim() || user.name?.trim() || user.email;

  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-4 p-1 sm:flex-row sm:items-center">
          <span
            className={cn(
              "grid size-11 shrink-0 place-items-center rounded-2xl",
              copy.tone === "ok" && "bg-success/10 text-success-foreground",
              copy.tone === "attention" &&
                "bg-warning/10 text-warning-foreground",
              copy.tone === "neutral" && "bg-primary/10 text-primary",
              copy.tone === "muted" && "bg-muted text-muted-foreground",
            )}
          >
            <copy.icon aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-balance">
              {t(copy.titleKey)}
            </h2>
            <p className="text-muted-foreground mt-1 text-sm text-pretty">
              {t.rich(copy.detailKey, {
                bdi: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
                host,
                identity,
                version:
                  card.type === "connected" || card.type === "outdated"
                    ? card.version
                    : "",
              })}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {card.type === "approve" ? (
              <Button
                loading={connection.status === "connecting"}
                onClick={onConnect}
                size="lg"
              >
                <LinkIcon />
                {t("common.approve")}
              </Button>
            ) : null}
            {offersDesktopSetup(card) ? (
              <Button
                loading={connection.status === "connecting"}
                onClick={onConnect}
                variant="outline"
              >
                {t("settings.account.desktopConnectInstalled")}
              </Button>
            ) : null}
          </div>
        </div>
        {offersDesktopSetup(card) ? (
          <div className="mt-4 border-t pt-4">
            <DesktopDownloadButtons platform={platform} />
          </div>
        ) : null}
        {connection.status === "error" ||
        connection.status === "update-required" ? (
          <div className="mt-3">
            <DesktopConnectionStatus onRetry={onConnect} state={connection} />
          </div>
        ) : null}
      </FramePanel>
    </Frame>
  );
};

const cardCopy = (card: DesktopCardState) => {
  switch (card.type) {
    case "connected":
      return {
        icon: CircleCheckIcon,
        tone: "ok",
        titleKey: "settings.account.desktopCardConnectedTitle",
        detailKey: card.version
          ? "settings.account.desktopCardConnectedDetail"
          : "settings.account.desktopCardConnectedDetailNoVersion",
      } as const;
    case "outdated":
      return {
        icon: TriangleAlertIcon,
        tone: "attention",
        titleKey: "settings.account.desktopCardOutdatedTitle",
        detailKey: "settings.account.desktopCardOutdatedDetail",
      } as const;
    case "approve":
      return {
        icon: LinkIcon,
        tone: "neutral",
        titleKey: "settings.account.desktopCardApproveTitle",
        detailKey: "settings.account.desktopCardApproveDetail",
      } as const;
    case "missing":
      return {
        icon: LaptopIcon,
        tone: "muted",
        titleKey: "settings.account.desktopCardMissingTitle",
        detailKey: "settings.account.desktopCardMissingDetail",
      } as const;
    default:
      card satisfies never;
      return panic("Unhandled desktop card state");
  }
};
