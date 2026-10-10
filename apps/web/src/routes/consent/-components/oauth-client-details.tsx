import { useTranslations } from "use-intl";

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
      <p>
        {t(
          destination === "loopback"
            ? "consent.returnsLocally"
            : "consent.returnsTo",
          { clientName },
        )}
      </p>
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
              {t.rich("consent.publishedBy", {
                host: (chunks) => <bdi>{chunks}</bdi>,
                publisherHost: info.clientIdHost,
              })}
            </p>
          ) : null}
        </div>
      </details>
    </div>
  );
};
