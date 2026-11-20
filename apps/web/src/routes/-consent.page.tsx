import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useLocation } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { resolveConsentClientIdentity } from "@/components/oauth-consent/client-identity.logic";
import {
  ConsentScrollBody,
  useConsentCardChrome,
} from "@/components/oauth-consent/consent-card";
import { consentChromePending } from "@/components/oauth-consent/consent-card-shell.pending";
import {
  ConsentAccountRows,
  ConsentActingAs,
  ConsentDecisionBar,
} from "@/components/oauth-consent/consent-controls";
import { useOAuthAccountSwitch } from "@/components/oauth-consent/oauth-account";
import { OAuthClientDetails } from "@/components/oauth-consent/oauth-client-details";
import { ScopeSummary } from "@/components/oauth-consent/scope-summary";
import { authClient, submitOAuthConsent } from "@/lib/auth-client";
import {
  refreshAuthQueries,
  roleOptions,
  sessionOptions,
} from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { toAuthClientError } from "@/lib/errors/auth";
import { transformUnknownError } from "@/lib/errors/client";
import { readQueryResult } from "@/lib/errors/query-result";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";
import {
  getOauthRedirectUrl,
  getSignedOauthQueryFromHash,
  oauthConsentInfoSchema,
} from "@/lib/oauth-provider";
import { organizationListOptions } from "@/lib/organization/queries";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";
import { optionalOrganizationSettingsOptions } from "@/lib/organization/settings-queries";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import {
  consentCompletion,
  isConsentAllowDisabled,
} from "@/routes/-consent-completion.logic";
import { ConsentSuccess } from "@/routes/-consent-success";

import { ConsentCardShell } from "./-consent.pending";

const routeApi = getRouteApi("/consent");

export function ConsentPage() {
  const t = useTranslations();
  const bridgedQuery = useLocation({
    select: (location) => getSignedOauthQueryFromHash(location.hash),
  });
  const bridgedParams = bridgedQuery ? new URLSearchParams(bridgedQuery) : null;
  const clientId = bridgedParams?.get("client_id") ?? null;
  const scope = bridgedParams?.get("scope") ?? undefined;
  const routeActiveOrganizationId = routeApi.useRouteContext({
    select: (ctx) => ctx.session?.activeOrganizationId ?? null,
  });
  // The session query follows an organization switch on this page; the route
  // context only knows the organization the page loaded with.
  const sessionView = queryView(useQuery(sessionOptions));
  useQueryViewError(sessionView, "ConsentPage:query");
  const activeOrganizationId =
    (sessionView.type === "items"
      ? sessionView.items?.session.activeOrganizationId
      : null) ?? routeActiveOrganizationId;
  const userId = routeApi.useRouteContext({ select: (ctx) => ctx.userId });
  const email = routeApi.useRouteContext({ select: (ctx) => ctx.user?.email });
  const queryClient = useQueryClient();
  const switchAccount = useOAuthAccountSwitch();
  const [submission, setSubmission] = useState<ConsentSubmission>({
    status: "idle",
  });
  const isPending = submission.status === "pending";
  const hasError = submission.status === "error";
  const organizationsView = queryView(
    useQuery(organizationListOptions(userId)),
  );
  useQueryViewError(organizationsView, "ConsentPage:query-2");
  const organizations =
    organizationsView.type === "items" ? organizationsView.items : undefined;
  const roleView = queryView(
    useQuery({
      ...roleOptions,
      enabled: activeOrganizationId !== null,
      staleTime: Number.POSITIVE_INFINITY,
    }),
  );
  useQueryViewError(roleView, "ConsentPage:query-3");
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
        return readQueryResult(Result.err(toAuthClientError(result.error)));
      }

      return v.parse(oauthConsentInfoSchema, result.data);
    },
  });

  const jurisdictionsView = queryView(
    useQuery({
      ...optionalOrganizationSettingsOptions({
        organizationId: activeOrganizationId,
        userId,
      }),
      enabled: activeOrganizationId !== null && canManageOrganization,
      select: (settings) => settings.practiceJurisdictions,
    }),
  );
  useQueryViewError(jurisdictionsView, "ConsentPage:query-4");
  const showJurisdictionsNotice =
    canManageOrganization && jurisdictionsView.type === "empty";

  const scopes = scope ? scope.split(" ").filter(Boolean) : [];
  const identity = resolveConsentClientIdentity(
    clientQuery.data,
    t("consent.defaultClientName"),
  );
  const chrome = useConsentCardChrome(identity);
  const clientName = identity.name;
  const organizationName =
    organizations?.find(
      (organization) => organization.id === activeOrganizationId,
    )?.name ?? null;

  const handleOrganizationSwitch = async (organizationId: string) => {
    setSubmission({ status: "pending" });
    // The grant binds to the session's active organization when consent is
    // given, so switching here is what decides where the app will work.
    const selected = await Result.tryPromise({
      try: async () =>
        await authClient.organization.setActive({ organizationId }),
      catch: transformUnknownError,
    });
    // A failed request may still have committed. Always confirm the session.
    const refreshed = await Result.tryPromise({
      try: async () => await refreshAuthQueries(queryClient),
      catch: transformUnknownError,
    });
    const outcome = refreshed.andThen(() =>
      selected.andThen(({ error }) =>
        error ? Result.err(toAuthClientError(error)) : Result.ok(undefined),
      ),
    );
    if (outcome.isErr()) {
      setSubmission({ status: "error" });
      notifyUserError(outcome.error, t("consent.error"));
      return;
    }
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
      notifyUserProblem(t("consent.error"));
      return;
    }

    const completion = consentCompletion({
      accept,
      redirectUrl,
      client: identity,
      organizationName,
    });
    switch (completion.status) {
      case "redirect":
        window.location.assign(completion.redirectUrl);
        return;
      case "connected":
        setSubmission(completion);
        return;
      default:
        completion satisfies never;
        panic("Unhandled consent completion");
    }
  };

  if (submission.status === "connected") {
    return (
      <ConsentSuccess
        identity={identity}
        organizationName={organizationName}
        redirectUrl={submission.redirectUrl}
        scopes={scopes}
      />
    );
  }

  return (
    <ConsentCardShell
      {...(clientId !== null && clientQuery.isPending
        ? consentChromePending
        : chrome)}
      Body={ConsentScrollBody}
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
          allowDisabled={isConsentAllowDisabled({
            clientInfoFailed: clientQuery.isError,
            clientInfoLoaded:
              clientQuery.data !== undefined && clientQuery.data !== null,
            session: sessionView,
          })}
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
        organizationsPending={organizationsView.type === "pending"}
        organizations={organizations}
      />
      <ConsentActingAs
        clientName={clientName}
        organizationName={organizationName}
        pending={
          activeOrganizationId !== null && organizationsView.type === "pending"
        }
      />
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
            to="/settings/organization/members"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("consent.completeSetup")}
          </Link>
        </div>
      ) : null}
    </ConsentCardShell>
  );
}

type ConsentSubmission =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error" }
  | { status: "connected"; redirectUrl: string };
