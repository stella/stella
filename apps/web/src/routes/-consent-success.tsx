import { useTranslations } from "use-intl";

import { Frame, FramePanel } from "@stll/ui/frame";

import { ConsentClientTiles } from "@/components/oauth-consent/client-identity";
import type { ConsentClientIdentity } from "@/components/oauth-consent/client-identity.logic";
import { useMountEffect } from "@/hooks/use-effect";

const SUCCESS_REDIRECT_DELAY_MS = 1500;

/** Confirms the connection with the consent card's tiles, then returns to the client. */
export const ConsentSuccess = ({
  identity,
  redirectUrl,
}: {
  identity: ConsentClientIdentity;
  redirectUrl: string;
}) => {
  const t = useTranslations("consent");
  useMountEffect(() => {
    const timeout = window.setTimeout(
      () => window.location.assign(redirectUrl),
      SUCCESS_REDIRECT_DELAY_MS,
    );
    return () => window.clearTimeout(timeout);
  });
  return (
    <main className="bg-muted/40 flex min-h-dvh flex-1 px-4 py-6">
      <Frame className="m-auto w-full max-w-xl">
        <FramePanel role="status">
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <ConsentClientTiles identity={identity} />
            <h1 className="text-2xl font-medium text-balance">
              {t("connectedTitle", { clientName: identity.name })}
            </h1>
            <p className="text-muted-foreground text-sm">
              {t("returnToAgent")}
            </p>
          </div>
        </FramePanel>
      </Frame>
    </main>
  );
};
