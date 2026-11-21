import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { ScrollArea } from "@stll/ui/scroll-area";

import {
  ConsentClientTiles,
  ConsentClientVerification,
} from "@/components/oauth-consent/client-identity";
import type { ConsentClientIdentity } from "@/components/oauth-consent/client-identity.logic";
import { ConsentCardShell } from "@/components/oauth-consent/consent-card-shell.pending";

type ConsentCardProps = {
  identity: ConsentClientIdentity;
  details: ReactNode;
  children: ReactNode;
  decision: ReactNode;
};

export const ConsentScrollBody = ({ children }: { children: ReactNode }) => (
  <ScrollArea axis="vertical" className="min-h-0 flex-1">
    {children}
  </ScrollArea>
);

export const useConsentCardChrome = (identity: ConsentClientIdentity) => {
  const t = useTranslations("consent");
  return {
    tiles: <ConsentClientTiles identity={identity} />,
    title: t("connectTitle", { clientName: identity.name }),
    verification: <ConsentClientVerification identity={identity} />,
  };
};

/** The decision stays outside the scrollable content at every viewport size. */
export const ConsentCard = ({
  identity,
  details,
  children,
  decision,
}: ConsentCardProps) => {
  const chrome = useConsentCardChrome(identity);
  return (
    <ConsentCardShell
      {...chrome}
      Body={ConsentScrollBody}
      details={details}
      decision={decision}
    >
      {children}
    </ConsentCardShell>
  );
};
