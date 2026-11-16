import { useTranslations } from "use-intl";

import { OutcomeScreen } from "@stll/ui/outcome-screen";

import { ConsentClientMark } from "@/components/oauth-consent/client-identity";
import type { ConsentClientIdentity } from "@/components/oauth-consent/client-identity.logic";
import { StellaWordmark } from "@/components/stella-wordmark";
import { useMountEffect } from "@/hooks/use-effect";
import { pageTitleLiteral } from "@/lib/page-title";

const SUCCESS_REDIRECT_DELAY_MS = 1500;

/** Confirms the connection beside the client's mark, then returns to the client. */
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
  const title = t("connectedTitle", { clientName: identity.name });
  return (
    <OutcomeScreen
      counterpart={<ConsentClientMark identity={identity} />}
      description={t("returningToClient", { clientName: identity.name })}
      documentTitle={pageTitleLiteral(title)}
      title={title}
      tone="success"
      wordmark={<StellaWordmark className="h-4 w-auto" />}
    />
  );
};
