import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { InfoIcon } from "@stll/ui/icons";
import {
  Popover,
  PopoverPanel,
  PopoverTrigger,
  PopoverTitle,
} from "@stll/ui/popover";

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
    <Popover>
      <PopoverTrigger
        aria-label={t("consent.destinationDetails")}
        render={<Button variant="ghost" className="size-11 shrink-0" />}
      >
        <InfoIcon className="size-4" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPanel align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <PopoverTitle>{t("consent.destinationDetails")}</PopoverTitle>
        <p>
          {t(
            destination === "loopback"
              ? "consent.returnsLocally"
              : "consent.returnsTo",
            { clientName },
          )}
        </p>
        <div className="text-muted-foreground">
          <div className="flex flex-col gap-1 pb-2">
            {info.redirectHosts.map((host) => (
              <p className="break-all" key={host}>
                <bdi>{host}</bdi>
              </p>
            ))}
            {info.clientIdHost ? (
              <p className="break-all">
                {t.rich("consent.publishedBy", {
                  host: (chunks) => <bdi>{chunks}</bdi>,
                  publisherHost: info.clientIdHost,
                })}
              </p>
            ) : null}
          </div>
        </div>
      </PopoverPanel>
    </Popover>
  );
};
