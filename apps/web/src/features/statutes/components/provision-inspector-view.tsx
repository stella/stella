import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";

import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { usePublicSignInRequest } from "@/components/public-sign-in-request";
import { ProvisionCitingDecisions } from "@/features/statutes/components/provision-citing-decisions";
import { ProvisionHistory } from "@/features/statutes/components/provision-history";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";
import { formatValidityDate } from "@/features/statutes/statute-format";
import { useFormatter } from "@/i18n/formatting-context";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { toStatuteCountrySegment } from "@/lib/statute-route";

// The ask actions pull the chat composer's draft machinery; a visitor who
// cannot chat never loads it.
const LazyProvisionAskActions = lazy(async () => {
  const module =
    await import("@/features/statutes/components/provision-ask-actions");
  return { default: module.ProvisionAskActions };
});

/**
 * One provision of a statute, in the inspector: who cites it, how its
 * wording changed, and a way to ask about it.
 */
export const ProvisionInspectorView = ({
  onClose,
  tab,
}: InspectorViewRenderProps<ProvisionViewPayload>) => {
  const t = useTranslations();
  const format = useFormatter();
  const { payload } = tab;
  const validFrom = formatValidityDate(payload.versionValidFrom, format);

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <InspectorTabHeader label={tab.label} onClose={onClose} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-6 p-4">
          <header className="flex flex-col gap-1">
            <p className="text-muted-foreground text-xs">
              {payload.statuteTitle}
            </p>
            <h2 className="text-base font-semibold">
              {payload.provisionLabel}
            </h2>
            {validFrom !== null && (
              <p className="text-muted-foreground text-xs">
                {t("statutes.inForceSince", { date: validFrom })}
              </p>
            )}
            <Link
              className="text-muted-foreground hover:text-foreground w-fit text-xs underline underline-offset-2"
              hash={payload.anchorId}
              params={{
                country: toStatuteCountrySegment(payload.jurisdiction),
                documentId: payload.documentId,
              }}
              to="/law/$country/statutes/$documentId"
            >
              {t("statutes.showInText")}
            </Link>
          </header>

          <ProvisionSection title={t("caseLaw.viewer.citedBy")}>
            <ProvisionCitingDecisions
              anchorId={payload.anchorId}
              eli={payload.eli}
              jurisdiction={payload.jurisdiction}
            />
          </ProvisionSection>

          {payload.versionCount > 1 && (
            <ProvisionSection title={t("common.history")}>
              <ProvisionHistory
                anchorId={payload.anchorId}
                documentId={payload.documentId}
              />
            </ProvisionSection>
          )}

          <ProvisionSection title={t("common.askAI")}>
            <ProvisionAsk payload={payload} />
          </ProvisionSection>
        </div>
      </ScrollArea>
    </div>
  );
};

const ProvisionSection = ({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) => (
  <section className="flex flex-col gap-2">
    <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
      {title}
    </h3>
    {children}
  </section>
);

/**
 * Asking needs a session: the chat is an account feature. A visitor is
 * offered the sign-in instead, and keeps the citations and history.
 */
const ProvisionAsk = ({ payload }: { payload: ProvisionViewPayload }) => {
  const t = useTranslations();
  const user = useMaybeAuthenticatedUser();
  const requestSignIn = usePublicSignInRequest();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });

  if (user !== null) {
    return (
      <Suspense fallback={<Skeleton className="h-16 w-full" />}>
        <LazyProvisionAskActions payload={payload} />
      </Suspense>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-muted-foreground text-xs">
        {t("statutes.provisionAskSignIn")}
      </p>
      {requestSignIn === null ? (
        <Button
          className="text-xs"
          render={<Link search={{ redirectTo: currentHref }} to="/auth" />}
          size="sm"
          variant="outline"
        >
          {t("auth.signIn")}
        </Button>
      ) : (
        <Button
          className="text-xs"
          onClick={() => requestSignIn(currentHref)}
          size="sm"
          variant="outline"
        >
          {t("auth.signIn")}
        </Button>
      )}
    </div>
  );
};
