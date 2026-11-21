import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { InfoIcon, PlugIcon, ShieldCheckIcon } from "@stll/ui/icons";
import { ListItemStatus } from "@stll/ui/list";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

import type { ConsentClientIdentity } from "@/components/oauth-consent/client-identity.logic";
import { ConsentClientTilePair } from "@/components/oauth-consent/consent-card-shell.pending";
import { VerifiedClientMark } from "@/components/oauth-consent/verified-client-mark";

/** The client's mark: its verified logo, else a neutral connection mark. */
export const ConsentClientMark = ({
  identity,
}: {
  identity: ConsentClientIdentity;
}) =>
  identity.type === "verified" ? (
    <VerifiedClientMark brand={identity.brand} className="size-6" />
  ) : (
    <PlugIcon className="size-6" data-slot="unverified-client-mark" />
  );

/** The client's tile beside stella's, above the consent decision. */
export const ConsentClientTiles = ({
  identity,
}: {
  identity: ConsentClientIdentity;
}) => (
  <ConsentClientTilePair client={<ConsentClientMark identity={identity} />} />
);

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
