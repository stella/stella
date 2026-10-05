import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";
import { CheckCircle2Icon } from "@stll/ui/icons";

import { StellaMark } from "@/components/stella-mark";
import { useMountEffect } from "@/hooks/use-effect";
import { signOutAndRelease } from "@/hooks/use-sign-out";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient, submitOAuthConsent } from "@/lib/auth-client";
import { roleOptions, sessionOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { toAuthClientError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  oauthConsentInfoSchema,
  getOauthHashFragment,
  getOauthClientDisplayName,
  getOauthRedirectUrl,
  getSignedOauthQueryFromHash,
} from "@/lib/oauth-provider";
import {
  type OAuthScopeGroup,
  type OAuthScopeDisplayEntry,
  groupOAuthScopeDisplayEntries,
  toOAuthScopeDisplayEntries,
  translateOAuthScopeEntry,
} from "@/lib/oauth-scopes";
import { organizationListOptions } from "@/lib/organization/queries";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";
import { optionalOrganizationSettingsOptions } from "@/lib/organization/settings-queries";
import { pageTitle } from "@/lib/page-title";
import { loadAuthContext } from "@/routes/-auth-context";
import { OAuthClientDetails } from "@/routes/consent/-components/oauth-client-details";

const SCOPE_GROUP_LABELS = {
  read: { group: "read", label: "consent.canRead" },
  change: { group: "change", label: "consent.canChange" },
  other: { group: "other", label: "consent.otherPermissions" },
} as const satisfies {
  [Group in OAuthScopeGroup]: { group: Group; label: TranslationKey };
};

export const Route = createFileRoute("/consent")({
  beforeLoad: async ({ context, location }) => {
    const authContext = await loadAuthContext(context.queryClient);
    const bridgedQuery = getSignedOauthQueryFromHash(location.hash);

    if (!authContext.session) {
      if (bridgedQuery) {
        throw redirect({
          href: `/auth#${getOauthHashFragment(bridgedQuery)}`,
          replace: true,
        });
      }

      throw redirect({
        to: "/auth",
        search: {
          redirectTo: location.pathname + location.searchStr,
        },
        replace: true,
      });
    }

    return { ...authContext, userId: authContext.session.userId };
  },
  head: () => ({
    meta: [{ title: pageTitle("consent.title") }],
  }),
  component: ConsentPage,
});

function ConsentPage() {
  const t = useTranslations();
  const bridgedQuery = useLocation({
    select: (location) => getSignedOauthQueryFromHash(location.hash),
  });
  const bridgedParams = bridgedQuery ? new URLSearchParams(bridgedQuery) : null;
  const clientId = bridgedParams?.get("client_id") ?? null;
  const scope = bridgedParams?.get("scope") ?? undefined;
  const activeOrganizationId = Route.useRouteContext({
    select: (ctx) => ctx.session?.activeOrganizationId ?? null,
  });
  const userId = Route.useRouteContext({ select: (ctx) => ctx.userId });
  const email = Route.useRouteContext({ select: (ctx) => ctx.user?.email });
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const [submission, setSubmission] = useState<ConsentSubmission>({
    status: "idle",
  });
  const isPending = submission.status === "pending";
  const hasError = submission.status === "error";
  const { data: organizations } = useQuery(organizationListOptions(userId));
  const { data: currentUserRole } = useQuery({
    ...roleOptions,
    enabled: activeOrganizationId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const canManageOrganization =
    hasOrganizationManagementAccess(currentUserRole);

  const clientQuery = useQuery({
    enabled: clientId !== null,
    queryKey: ["oauth-consent-info", clientId],
    queryFn: async ({ signal }) => {
      if (!clientId) {
        return null;
      }

      const result = await authClient.$fetch("/oauth2/consent-info", {
        query: { client_id: clientId },
        signal,
      });

      if (result.error) {
        throw toAuthClientError(result.error);
      }

      return v.parse(oauthConsentInfoSchema, result.data);
    },
  });

  const jurisdictionsQuery = useQuery({
    ...optionalOrganizationSettingsOptions({
      organizationId: activeOrganizationId,
      userId,
    }),
    enabled: activeOrganizationId !== null && canManageOrganization,
    select: (settings) => settings.practiceJurisdictions,
  });
  const showJurisdictionsNotice =
    canManageOrganization && jurisdictionsQuery.data?.length === 0;

  const scopes = scope ? scope.split(" ").filter(Boolean) : [];
  const clientName =
    getOauthClientDisplayName(clientQuery.data) ??
    t("consent.defaultClientName");
  const organizationName =
    organizations?.find(
      (organization) => organization.id === activeOrganizationId,
    )?.name ?? null;

  // Every requested scope must be disclosed, even one the server never
  // grants: unknown scopes fall back to the raw scope string instead of
  // being silently skipped.
  const scopeEntries = toOAuthScopeDisplayEntries(scopes);

  const groupedScopes = groupOAuthScopeDisplayEntries(scopeEntries);

  const handleAccountSwitch = async () => {
    setSubmission({ status: "pending" });
    const outcome = await Result.tryPromise(
      async () => await signOutAndRelease(),
    );
    if (outcome.isErr()) {
      await queryClient.refetchQueries({ queryKey: sessionOptions.queryKey });
      setSubmission({ status: "error" });
      notifyUserError(outcome.error, t("consent.error"));
      return;
    }
    const result = outcome.value;
    if (result.error) {
      await queryClient.refetchQueries({ queryKey: sessionOptions.queryKey });
      setSubmission({ status: "error" });
      notifyUserError(toAuthClientError(result.error), t("consent.error"));
      return;
    }
    analytics.reset();
    const authUrl = bridgedQuery
      ? `/auth#${getOauthHashFragment(bridgedQuery)}`
      : `/auth?${new URLSearchParams({ redirectTo: window.location.pathname + window.location.search })}`;
    window.location.assign(authUrl);
  };

  const handleConsent = async (accept: boolean) => {
    setSubmission({ status: "pending" });

    const outcome = await Result.tryPromise(
      async () => await submitOAuthConsent(accept),
    );
    if (outcome.isErr()) {
      setSubmission({ status: "error" });
      notifyUserError(outcome.error, t("consent.error"));
      return;
    }
    const result = outcome.value;
    if (result.error) {
      setSubmission({ status: "error" });
      notifyUserError(toAuthClientError(result.error), t("consent.error"));
      return;
    }

    const redirectUrl = getOauthRedirectUrl(result.data);
    if (!redirectUrl) {
      setSubmission({ status: "error" });
      notifyUserError(undefined, t("consent.error"));
      return;
    }

    if (!accept) {
      window.location.assign(redirectUrl);
      return;
    }
    setSubmission({ status: "connected", redirectUrl });
  };

  if (submission.status === "connected") {
    return (
      <ConsentSuccess
        clientName={clientName}
        redirectUrl={submission.redirectUrl}
      />
    );
  }

  return (
    <main className="bg-muted/40 flex min-h-dvh flex-1 px-4 py-6 sm:px-6 sm:py-10">
      <Frame className="m-auto w-full max-w-xl">
        <FrameHeader className="gap-4">
          <div className="flex items-center gap-3" aria-hidden="true">
            <div className="bg-background outline-foreground/8 flex size-11 shrink-0 items-center justify-center rounded-xl text-lg font-medium shadow-xs outline-1">
              {Array.from(clientName).at(0)}
            </div>
            <span className="text-muted-foreground">+</span>
            <div className="bg-background outline-foreground/8 flex size-11 shrink-0 items-center justify-center rounded-xl shadow-xs outline-1">
              <StellaMark className="text-foreground size-6" />
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <FrameTitle>
              <h1 className="text-balance">
                {t("consent.connectTitle", { clientName })}
              </h1>
            </FrameTitle>
            {organizationName ? (
              <FrameDescription className="text-pretty">
                {t("consent.actingAs", { clientName, organizationName })}
              </FrameDescription>
            ) : null}
          </div>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-x-3 text-sm">
            <p className="min-w-0 break-all">
              {t.rich("consent.signedInAs", {
                accountEmail: email ?? "",
                email: (chunks) => <bdi>{chunks}</bdi>,
              })}
            </p>
            <Button
              variant="ghost"
              className="min-h-11"
              disabled={isPending}
              onClick={() => {
                detached(handleAccountSwitch(), "consent.switch-account");
              }}
            >
              {t("consent.useAnotherAccount")}
            </Button>
          </div>
          {clientQuery.data ? (
            <OAuthClientDetails
              info={clientQuery.data}
              clientName={clientName}
              redirectUri={bridgedParams?.get("redirect_uri") ?? null}
            />
          ) : null}
          {clientQuery.isError ? (
            <p role="alert" className="text-destructive text-sm">
              {t("consent.error")}
            </p>
          ) : null}
          <div className="flex flex-col gap-4">
            {Object.values(SCOPE_GROUP_LABELS).map(({ group, label }) =>
              groupedScopes[group].length > 0 ? (
                <section key={group} className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium">{t(label)}</h2>
                  <ul className="flex flex-col gap-2">
                    {groupedScopes[group].map((entry) => (
                      <li
                        className="flex items-start gap-2 text-sm"
                        key={entry.type === "known" ? entry.label : entry.scope}
                      >
                        <span
                          aria-hidden="true"
                          className="bg-muted-foreground mt-2 size-1 shrink-0 rounded-full"
                        />
                        <ScopeLabel entry={entry} />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null,
            )}
          </div>
          <p className="text-muted-foreground text-xs text-pretty">
            {t("consent.connectionDuration")}
          </p>
          {showJurisdictionsNotice ? (
            <div className="border-border bg-muted/50 flex flex-col gap-2 rounded-md border p-3">
              <p className="text-foreground text-sm">
                {t("consent.missingJurisdictions")}
              </p>
              <Link
                className="text-primary text-sm font-medium hover:underline"
                to="/settings/organization/members"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("consent.completeSetup")}
              </Link>
            </div>
          ) : null}
          {hasError ? (
            <p className="text-destructive text-sm">{t("consent.error")}</p>
          ) : null}
          <div className="border-border/64 grid grid-cols-2 gap-3 border-t pt-4">
            <Button
              className="min-h-11 w-full"
              disabled={isPending}
              onClick={() => {
                detached(handleConsent(false), "consent.decline");
              }}
              type="button"
              variant="outline"
            >
              {t("common.decline")}
            </Button>
            <Button
              className="min-h-11 w-full"
              disabled={isPending || !clientQuery.data}
              loading={isPending}
              onClick={() => {
                detached(handleConsent(true), "consent.allow");
              }}
              type="button"
            >
              {t("consent.allow")}
            </Button>
          </div>
        </FramePanel>
      </Frame>
    </main>
  );
}

function ScopeLabel({ entry }: { entry: OAuthScopeDisplayEntry }) {
  const t = useTranslations();

  return <bdi>{translateOAuthScopeEntry(t, entry)}</bdi>;
}

type ConsentSubmission =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error" }
  | { status: "connected"; redirectUrl: string };

const SUCCESS_REDIRECT_DELAY_MS = 1500;

function ConsentSuccess({
  clientName,
  redirectUrl,
}: {
  clientName: string;
  redirectUrl: string;
}) {
  const t = useTranslations();
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
        <FramePanel
          className="flex flex-col items-center gap-4 py-10 text-center"
          role="status"
        >
          <CheckCircle2Icon className="size-9" aria-hidden="true" />
          <h1 className="text-2xl font-medium text-balance">
            {t("consent.connectedTitle", { clientName })}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("consent.returnToAgent")}
          </p>
        </FramePanel>
      </Frame>
    </main>
  );
}
