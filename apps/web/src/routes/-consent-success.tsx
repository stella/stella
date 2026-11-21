import { useTranslations } from "use-intl";

import { OutcomeScreen } from "@stll/ui/outcome-screen";
import type { OutcomeDetail } from "@stll/ui/outcome-screen";

import { ConsentClientMark } from "@/components/oauth-consent/client-identity";
import type { ConsentClientIdentity } from "@/components/oauth-consent/client-identity.logic";
import { useMountEffect } from "@/hooks/use-effect";
import { toOAuthScopeDisplayEntries } from "@/lib/oauth-scopes";
import { pageTitleLiteral } from "@/lib/page-title";

const SUCCESS_REDIRECT_DELAY_MS = 1500;

type ConsentSuccessScreenProps = {
  identity: ConsentClientIdentity;
  /** The organization the grant binds to, when the session names one. */
  organizationName: string | null;
  /** The scopes just granted, as the consent screen listed them. */
  scopes: readonly string[];
};

/** The connection just made: the client's mark beside stella's, and what it can reach. */
export const ConsentSuccessScreen = ({
  identity,
  organizationName,
  scopes,
}: ConsentSuccessScreenProps) => {
  const t = useTranslations();
  const title = t("consent.connectedTitle", { clientName: identity.name });
  const permissions = toOAuthScopeDisplayEntries(scopes).length;
  const details: OutcomeDetail[] = [
    ...(organizationName
      ? [{ label: t("common.organization"), value: organizationName }]
      : []),
    ...(permissions > 0
      ? [
          {
            label: t("common.access"),
            value: t("common.permissionCount", { count: permissions }),
          },
        ]
      : []),
  ];
  return (
    <OutcomeScreen
      counterpart={<ConsentClientMark identity={identity} />}
      description={t("consent.returningToClient", {
        clientName: identity.name,
      })}
      details={details}
      documentTitle={pageTitleLiteral(title)}
      title={title}
      tone="success"
    />
  );
};

/** Confirms the connection, then returns to the client. */
export const ConsentSuccess = ({
  redirectUrl,
  ...screen
}: ConsentSuccessScreenProps & { redirectUrl: string }) => {
  useMountEffect(() => {
    const timeout = window.setTimeout(
      () => window.location.assign(redirectUrl),
      SUCCESS_REDIRECT_DELAY_MS,
    );
    return () => window.clearTimeout(timeout);
  });
  return <ConsentSuccessScreen {...screen} />;
};
