import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { ScrollArea } from "@stll/ui/scroll-area";

import {
  ConsentClientTiles,
  ConsentClientVerification,
} from "@/routes/consent/-components/client-identity";
import type { ConsentClientIdentity } from "@/routes/consent/-components/client-identity.logic";

type ConsentCardProps = {
  identity: ConsentClientIdentity;
  details: ReactNode;
  children: ReactNode;
  decision: ReactNode;
};

/** The decision stays outside the scrollable content at every viewport size. */
export const ConsentCard = ({
  identity,
  details,
  children,
  decision,
}: ConsentCardProps) => {
  const t = useTranslations();
  return (
    <main className="bg-muted/40 flex h-dvh flex-1 sm:px-6 sm:py-6">
      <div
        className="bg-background flex size-full max-h-dvh flex-col shadow-sm sm:m-auto sm:h-auto sm:max-h-full sm:max-w-xl sm:overflow-hidden sm:rounded-2xl"
        data-slot="consent-card"
      >
        <ScrollArea axis="vertical" className="min-h-0 flex-1">
          <header className="flex flex-col gap-5 px-6 pt-6 pb-4">
            <div className="flex items-center justify-between gap-4">
              <ConsentClientTiles identity={identity} />
              {details}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <h1 className="text-xl leading-tight font-semibold text-balance sm:text-2xl">
                {t("consent.connectTitle", { clientName: identity.name })}
              </h1>
              <ConsentClientVerification identity={identity} />
            </div>
          </header>
          <div className="flex flex-col gap-5 px-6 pt-2 pb-6">{children}</div>
        </ScrollArea>
        {decision}
      </div>
    </main>
  );
};
