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

import { Frame, FramePanel } from "@stll/ui/frame";
import { CheckCircle2Icon } from "@stll/ui/icons";

import { resolveConsentClientIdentity } from "@/components/oauth-consent/client-identity.logic";
import { ConsentCard } from "@/components/oauth-consent/consent-card";
import {
  ConsentAccountRows,
  ConsentDecisionBar,
} from "@/components/oauth-consent/consent-controls";
import { useOAuthAccountSwitch } from "@/components/oauth-consent/oauth-account";
import { OAuthClientDetails } from "@/components/oauth-consent/oauth-client-details";
import { ScopeSummary } from "@/components/oauth-consent/scope-summary";
import { useMountEffect } from "@/hooks/use-effect";
import { authClient, submitOAuthConsent } from "@/lib/auth-client";
import {
  refreshAuthQueries,
  roleOptions,
  sessionOptions,
} from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { toAuthClientError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  getOauthClientDisplayName,
  getOauthHashFragment,
  getOauthRedirectUrl,
  getSignedOauthQueryFromHash,
  oauthConsentInfoSchema,
} from "@/lib/oauth-provider";
import { organizationListOptions } from "@/lib/organization/queries";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";
import { optionalOrganizationSettingsOptions } from "@/lib/organization/settings-queries";
import { pageTitle } from "@/lib/page-title";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import { APP_FRAME_SCOPE } from "@/routes/-app-frame-scope";
import { loadAuthContext } from "@/routes/-auth-context";

export const Route = createFileRoute("/consent")({
  staticData: { appFrame: APP_FRAME_SCOPE.none },
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
  const routeActiveOrganizationId = Route.useRouteContext({
    select: (ctx) => ctx.session?.activeOrganizationId ?? null,
  });
  // The session query follows an organization switch on this page; the route
  // context only knows the organization the page loaded with.
  const sessionView = useQueryView(useQuery(sessionOptions));
  useQueryViewError(sessionView);
  const activeOrganizationId =
    (sessionView.type === "items"
      ? sessionView.items?.session.activeOrganizationId
      : null) ?? routeActiveOrganizationId;
  const userId = Route.useRouteContext({ select: (ctx) => ctx.userId });
  const email = Route.useRouteContext({ select: (ctx) => ctx.user?.email });
  const queryClient = useQueryClient();
  const switchAccount = useOAuthAccountSwitch();
  const [submission, setSubmission] = useState<ConsentSubmission>({
    status: "idle",
  });
  const isPending = submission.status === "pending";
  const hasError = submission.status === "error";
  const organizationsView = useQueryView(
    useQuery(organizationListOptions(userId)),
  );
  useQueryViewError(organizationsView);
  const organizations =
    organizationsView.type === "items" ? organizationsView.items : undefined;
  const roleView = useQueryView(
    useQuery({
      ...roleOptions,
      enabled: activeOrganizationId !== null,
      staleTime: Number.POSITIVE_INFINITY,
    }),
  );
  useQueryViewError(roleView);
  const canManageOrganization =
    roleView.type === "items" &&
    roleView.refetchError === undefined &&
    hasOrganizationManagementAccess(roleView.items);

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

  const jurisdictionsView = useQueryView(
    useQuery({
      ...optionalOrganizationSettingsOptions({
        organizationId: activeOrganizationId,
        userId,
      }),
      enabled: activeOrganizationId !== null && canManageOrganization,
      select: (settings) => settings.practiceJurisdictions,
    }),
  );
  useQueryViewError(jurisdictionsView);
  const showJurisdictionsNotice =
    canManageOrganization && jurisdictionsView.type === "empty";

  const scopes = scope ? scope.split(" ").filter(Boolean) : [];
  const identity = resolveConsentClientIdentity(
    clientQuery.data,
    getOauthClientDisplayName(clientQuery.data) ??
      t("consent.defaultClientName"),
  );
  const clientName = identity.name;
  const organizationName =
    organizations?.find(
      (organization) => organization.id === activeOrganizationId,
    )?.name ?? null;

  const handleOrganizationSwitch = async (organizationId: string) => {
    setSubmission({ status: "pending" });
    // The grant binds to the session's active organization when consent is
    // given, so switching here is what decides where the app will work.
    const outcome = await Result.tryPromise(
      async () => await authClient.organization.setActive({ organizationId }),
    );
    // On failure the request may still have reached the server, so re-read
    // the session: the page must show the organization Allow would bind to.
    if (outcome.isErr()) {
      await refreshAuthQueries(queryClient);
      setSubmission({ status: "error" });
      notifyUserError(outcome.error, t("consent.error"));
      return;
    }
    if (outcome.value.error) {
      await refreshAuthQueries(queryClient);
      setSubmission({ status: "error" });
      notifyUserError(
        toAuthClientError(outcome.value.error),
        t("consent.error"),
      );
      return;
    }
    await refreshAuthQueries(queryClient);
    setSubmission({ status: "idle" });
  };

  const handleAccountSwitch = async () => {
    setSubmission({ status: "pending" });
    const outcome = await switchAccount();
    if (outcome.isErr()) {
      setSubmission({ status: "error" });
      notifyUserError(outcome.error, t("consent.error"));
    }
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
    <ConsentCard
      identity={identity}
      details={
        clientQuery.data ? (
          <OAuthClientDetails
            info={clientQuery.data}
            clientName={clientName}
            redirectUri={bridgedParams?.get("redirect_uri") ?? null}
          />
        ) : null
      }
      decision={
        <ConsentDecisionBar
          allowDisabled={clientQuery.isError || !clientQuery.data}
          hasError={hasError}
          isPending={isPending}
          onDecide={(accept) => {
            if (accept) {
              detached(handleConsent(true), "consent.allow");
              return;
            }
            detached(handleConsent(false), "consent.decline");
          }}
        />
      }
    >
      <ConsentAccountRows
        activeOrganizationId={activeOrganizationId}
        disabled={isPending}
        email={email ?? ""}
        onAccountSwitch={() => {
          detached(handleAccountSwitch(), "consent.switch-account");
        }}
        onOrganizationSwitch={(organizationId) => {
          detached(
            handleOrganizationSwitch(organizationId),
            "consent.switch-organization",
          );
        }}
        organizationName={organizationName}
        organizations={organizations}
      />
      {organizationName ? (
        <p className="text-muted-foreground -mt-3 text-sm text-pretty">
          {t("consent.actingAs", { clientName, organizationName })}
        </p>
      ) : null}
      <ScopeSummary scopes={scopes} />
      {clientQuery.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {t("consent.error")}
        </p>
      ) : null}
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
            to="/admin/members"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("consent.completeSetup")}
          </Link>
        </div>
      ) : null}
    </ConsentCard>
  );
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
