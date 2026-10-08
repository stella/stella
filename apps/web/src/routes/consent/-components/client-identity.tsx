import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { InfoIcon, ShieldCheckIcon } from "@stll/ui/icons";
import { ListItemStatus } from "@stll/ui/list";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import { StellaMark } from "@/components/stella-mark";
import type { ConsentClientIdentity } from "@/routes/consent/-components/client-identity.logic";
import {
  hasVerifiedClientMark,
  VerifiedClientMark,
} from "@/routes/consent/-components/verified-client-mark";

const TILE_CLASS =
  "bg-background outline-foreground/8 flex size-11 shrink-0 items-center justify-center rounded-xl shadow-xs outline-1";

/** The client's tile beside stella's: a verified mark, else its initial. */
export const ConsentClientTiles = ({
  identity,
}: {
  identity: ConsentClientIdentity;
}) => {
  const mark =
    identity.type === "verified" && hasVerifiedClientMark(identity.brand) ? (
      <VerifiedClientMark brand={identity.brand} className="size-6" />
    ) : null;
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <div className={cn(TILE_CLASS, "text-lg font-medium")}>
        {mark ?? Array.from(identity.name).at(0)}
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
  const t = useTranslations();
  switch (identity.type) {
    case "verified":
      return (
        <p className="text-muted-foreground flex min-h-6 items-center gap-1.5 text-sm">
          <ShieldCheckIcon
            className="text-foreground size-4 shrink-0"
            aria-hidden="true"
          />
          {t("consent.verifiedPublisher", { publisher: identity.publisher })}
        </p>
      );
    case "verified_unbranded":
      return (
        <p className="text-muted-foreground flex min-h-6 items-center gap-1.5 text-sm">
          <ShieldCheckIcon
            className="text-foreground size-4 shrink-0"
            aria-hidden="true"
          />
          {t("common.verified")}
        </p>
      );
    case "unverified":
      return (
        <Tooltip>
          <TooltipTrigger className="inline-flex min-h-11 items-center self-start">
            <ListItemStatus tone="warning">
              {t("consent.unverifiedApp")}
              <InfoIcon className="size-3" aria-hidden="true" />
            </ListItemStatus>
          </TooltipTrigger>
          <TooltipPopup>{t("consent.unverifiedExplanation")}</TooltipPopup>
        </Tooltip>
      );
    default:
      identity satisfies never;
      return panic("Unhandled consent client identity");
  }
};
