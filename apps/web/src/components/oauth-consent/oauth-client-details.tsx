import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { InfoIcon } from "@stll/ui/icons";
import {
  Popover,
  PopoverPanel,
  PopoverTitle,
  PopoverTrigger,
} from "@stll/ui/popover";

import { classifyOAuthDestination } from "@/components/oauth-consent/oauth-destination.logic";
import type { OAuthConsentInfo } from "@/lib/oauth-provider";

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
  const t = useTranslations("consent");
  const destination = classifyOAuthDestination(info, redirectUri);
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t("destinationDetails")}
        render={
          <Button
            className="size-11 shrink-0"
            tooltip={t("destinationDetails")}
            variant="ghost"
          />
        }
      >
        <InfoIcon className="size-4" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPanel align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <PopoverTitle>{t("destinationDetails")}</PopoverTitle>
        <p>
          {t(destination === "loopback" ? "returnsLocally" : "returnsTo", {
            clientName,
          })}
        </p>
        <div className="text-muted-foreground">
          <div className="flex flex-col gap-1 pb-2">
            {info.redirectTargets.map((target) => (
              <p className="break-all" key={target}>
                <bdi>{target}</bdi>
              </p>
            ))}
            {info.clientIdHost ? (
              <p className="break-all">
                {t.rich("publishedBy", {
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
