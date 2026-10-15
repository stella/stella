import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { InfoIcon, PlugIcon, ShieldCheckIcon } from "@stll/ui/icons";
import { ListItemStatus } from "@stll/ui/list";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import type { ConsentClientIdentity } from "@/components/oauth-consent/client-identity.logic";
import { VerifiedClientMark } from "@/components/oauth-consent/verified-client-mark";
import { StellaMark } from "@/components/stella-mark";

const TILE_CLASS =
  "bg-background outline-foreground/8 flex size-11 shrink-0 items-center justify-center rounded-xl shadow-xs outline-1";

/** The client's tile beside stella's: a verified mark, else a neutral connection mark. */
export const ConsentClientTiles = ({
  identity,
}: {
  identity: ConsentClientIdentity;
}) => {
  const mark =
    identity.type === "verified" ? (
      <VerifiedClientMark brand={identity.brand} className="size-6" />
    ) : null;
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <div className={cn(TILE_CLASS, "text-lg font-medium")}>
        {mark ?? (
          <PlugIcon className="size-6" data-slot="unverified-client-mark" />
        )}
      </div>
      <span className="text-muted-foreground">+</span>
      <div className={TILE_CLASS}>
        <StellaMark className="size-6" />
      </div>
    </div>
  );
};

/** One line under the title: who verified the client, or that nobody did. */
export const ConsentClientVerification = ({
  identity,
}: {
  identity: ConsentClientIdentity;
}) => {
  const t = useTranslations("consent");
  switch (identity.type) {
    case "verified":
      return (
        <p className="text-muted-foreground flex min-h-6 items-center gap-1.5 text-sm">
          <ShieldCheckIcon
            className="text-foreground size-4 shrink-0"
            aria-hidden="true"
          />
          {t("verifiedPublisher", { publisher: identity.publisher })}
        </p>
      );
    case "unknown":
      return null;
    case "verified_unbranded":
      // The location is known, but it does not identify the publisher, so
      // nothing is claimed about who made the app.
      return null;
    case "unverified":
      return (
        <Tooltip>
          <TooltipTrigger className="inline-flex min-h-11 items-center self-start">
            <ListItemStatus tone="warning">
              {t("unverifiedApp")}
              <InfoIcon className="size-3" aria-hidden="true" />
            </ListItemStatus>
          </TooltipTrigger>
          <TooltipPopup>{t("unverifiedExplanation")}</TooltipPopup>
        </Tooltip>
      );
    default:
      identity satisfies never;
      return panic("Unhandled consent client identity");
  }
};
