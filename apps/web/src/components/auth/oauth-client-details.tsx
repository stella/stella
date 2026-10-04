import { useTranslations } from "use-intl";

import type { OAuthConsentInfo } from "@/lib/oauth-provider";

export const OAuthClientDetails = ({ info }: { info: OAuthConsentInfo }) => {
  const t = useTranslations();
  return (
    <div className="border-border flex flex-col gap-2 rounded-lg border p-3">
      <p className="text-muted-foreground text-sm">
        {t("consent.redirectDestination")}
      </p>
      {info.redirectHosts.map((host) => (
        <p className="text-base font-medium break-all" key={host}>
          <bdi>{host}</bdi>
        </p>
      ))}
      {info.clientIdHost ? (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-sm">
            {t("consent.appIdentity")}
          </p>
          <p className="text-sm break-all">
            <bdi>{info.clientIdHost}</bdi>
          </p>
        </div>
      ) : null}
      {info.unverified ? (
        <p className="text-sm font-medium">{t("consent.unverifiedApp")}</p>
      ) : null}
    </div>
  );
};
