import { useTranslations } from "use-intl";

import { InfoIcon } from "@stll/ui/icons";
import { ListItemStatus } from "@stll/ui/list";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

import type { OAuthConsentInfo } from "@/lib/oauth-provider";
import { classifyOAuthDestination } from "@/routes/consent/-components/oauth-destination.logic";

type OAuthClientDetailsProps = {
  info: OAuthConsentInfo;
  clientName: string;
  redirectUri: string | null;
};

export const OAuthClientDetails = ({
  info,
  clientName,
  redirectUri,
}: OAuthClientDetailsProps) => {
  const t = useTranslations();
  const destination = classifyOAuthDestination(info, redirectUri);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-x-3">
        <p>
          {t(
            destination === "loopback"
              ? "consent.returnsLocally"
              : "consent.returnsTo",
            { clientName },
          )}
        </p>
        <PublisherIdentity info={info} />
      </div>
      <details className="text-muted-foreground">
        <summary className="min-h-11 cursor-pointer content-center">
          {t("consent.destinationDetails")}
        </summary>
        <div className="flex flex-col gap-1 pb-2">
          {info.redirectHosts.map((host) => (
            <p className="break-all" key={host}>
              <bdi>{host}</bdi>
            </p>
          ))}
          {info.clientIdHost ? (
            <p className="break-all">
              <bdi>{info.clientIdHost}</bdi>
            </p>
          ) : null}
        </div>
      </details>
    </div>
  );
};

function PublisherIdentity({ info }: { info: OAuthConsentInfo }) {
  const t = useTranslations();
  if (info.unverified) {
    return (
      <Tooltip>
        <TooltipTrigger className="inline-flex min-h-11 items-center">
          <ListItemStatus>
            {t("consent.unverifiedApp")}
            <InfoIcon className="size-3" aria-hidden="true" />
          </ListItemStatus>
        </TooltipTrigger>
        <TooltipPopup>{t("consent.unverifiedExplanation")}</TooltipPopup>
      </Tooltip>
    );
  }
  if (!info.clientIdHost) {
    return null;
  }
  return (
    <p className="text-muted-foreground">
      {t.rich("consent.publishedBy", {
        host: (chunks) => <bdi>{chunks}</bdi>,
        publisherHost: info.clientIdHost,
      })}
    </p>
  );
}
