import { useSyncExternalStore } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { useMountEffect } from "@stll/ui/effects";
import {
  CircleCheckIcon,
  ExternalLinkIcon,
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
import {
  DESKTOP_CARD_TILE_CLASS,
  DesktopConnectionCardFrame,
} from "@/features/desktop/desktop-connection-card.pending";
import { DesktopConnectionStatus } from "@/features/desktop/desktop-connection-status";
import type { DesktopLinkApproval } from "@/features/desktop/desktop-connection-store.logic";
import { desktopPresenceOptions } from "@/features/desktop/desktop-presence";
import { useDesktopAccountConnection } from "@/features/desktop/use-desktop-account-connection";
import { useHydrationSafeDesktopPlatform } from "@/hooks/use-hydration-safe-desktop-platform";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import {
  captureDesktopAccountLink,
  hasDesktopAccountChallenge,
  openDesktopUrl,
} from "@/lib/desktop-bridge";
import { detached } from "@/lib/detached";
import { notifyUserProblem } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";

const noopSubscribe = () => () => undefined;
const serverHost = () => window.location.host;
const noServerHost = () => "";

// The bridge holds the challenge the desktop app left for this tab; the card
// re-reads it whenever a capture or a connect attempt may have changed it.
const CHALLENGE_CHANGED_EVENT = "stella:desktop-account-challenge-changed";
const subscribeToChallenge = (onChange: () => void) => {
  window.addEventListener(CHALLENGE_CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener(CHALLENGE_CHANGED_EVENT, onChange);
  };
};
const notifyChallengeChanged = () => {
  window.dispatchEvent(new Event(CHALLENGE_CHANGED_EVENT));
};
const noChallengeOnServer = () => false;

/**
 * The one place a person links stella desktop: it says what was found on
 * this computer, which account and server a link would use, and offers the
 * single action that moves it forward.
 */
export const DesktopConnectionCard = () => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const platform = useHydrationSafeDesktopPlatform();
  const {
    connect,
    state: connection,
    switchAccount,
  } = useDesktopAccountConnection();
  const presenceQuery = useQuery(
    desktopPresenceOptions({
      userId: user.id,
      organizationId: user.activeOrganizationId,
    }),
  );
  const presenceView = queryView(presenceQuery);
  // An unreadable record never claims a link; the card falls back to what it
  // can see on this computer.
  const presence =
    presenceView.type === "items" ? presenceView.items : undefined;
  const challengeWaiting = useSyncExternalStore(
    subscribeToChallenge,
    hasDesktopAccountChallenge,
    noChallengeOnServer,
  );
  const host = useSyncExternalStore(noopSubscribe, serverHost, noServerHost);

  const handleConnect = async (approval: DesktopLinkApproval) => {
    const outcome = await connect(approval);
    // A failed or unproven approval keeps a challenge that is still valid;
    // an expired or consumed one falls back to the install-or-connect offer.
    notifyChallengeChanged();
    // A refusal names its own next step in the status below the card.
    if (
      outcome.status === "started" ||
      outcome.status === "approval-required" ||
      outcome.status === "update-required" ||
      outcome.status === "refused"
    ) {
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
  const startConnect = (approval: DesktopLinkApproval) => {
    detached(
      handleConnect(approval),
      "settings-account-desktop.connect-desktop",
    );
  };

  // Capture the native challenge and remove its secret from browser history.
  // The page answers it on its own only when the app on this computer proves
  // the challenge is its own; otherwise the approve button stays.
  useMountEffect(() => {
    captureDesktopAccountLink();
    notifyChallengeChanged();
    if (hasDesktopAccountChallenge()) {
      startConnect("local-proof");
    }
  });

  const card = desktopCardState({ challengeWaiting, connection, presence });

  const onConnect = () => {
    startConnect("explicit");
  };

  const copy = cardCopy(card);
  const identity =
    user.preferredName?.trim() || user.name?.trim() || user.email;

  return (
    <DesktopConnectionCardFrame
      actions={
        <>
          {card.type === "verifying" ? (
            <Button loading variant="outline">
              <ExternalLinkIcon />
              {t("settings.account.desktopOpenApp")}
            </Button>
          ) : null}
          {card.type === "opening" ? (
            <Button
              onClick={() => {
                openDesktopUrl(card.desktopUrl);
              }}
              variant="outline"
            >
              <ExternalLinkIcon />
              {t("settings.account.desktopOpenApp")}
            </Button>
          ) : null}
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
        </>
      }
      detail={t.rich(copy.detailKey, {
        bdi: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
        host,
        identity,
        version:
          card.type === "connected" || card.type === "outdated"
            ? card.version
            : "",
      })}
      tile={
        <span
          className={cn(
            DESKTOP_CARD_TILE_CLASS,
            copy.tone === "ok" && "bg-success/10 text-success-foreground",
            copy.tone === "attention" &&
              "bg-warning/10 text-warning-foreground",
            copy.tone === "neutral" && "bg-primary/10 text-primary",
            copy.tone === "muted" && "bg-muted text-muted-foreground",
          )}
        >
          <copy.icon aria-hidden="true" className="size-5" />
        </span>
      }
      title={t(copy.titleKey)}
    >
      {offersDesktopSetup(card) ? (
        <div className="mt-4 border-t pt-4">
          <DesktopDownloadButtons platform={platform} />
        </div>
      ) : null}
      {connection.status === "error" ||
      connection.status === "update-required" ||
      connection.status === "refused" ? (
        <div className="mt-3">
          <DesktopConnectionStatus
            onRetry={onConnect}
            onSwitchAccount={switchAccount}
            state={connection}
          />
        </div>
      ) : null}
    </DesktopConnectionCardFrame>
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
    case "verifying":
    case "opening":
      return {
        icon: LaptopIcon,
        tone: "neutral",
        titleKey: "settings.account.desktopCardOpeningTitle",
        detailKey: "settings.account.desktopCardOpeningDetail",
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
