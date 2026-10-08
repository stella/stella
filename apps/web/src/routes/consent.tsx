import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import { Result } from "better-result";
import { useFormatter, useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/button";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@stll/ui/frame";
import { CheckCircle2Icon, TriangleAlertIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { useMountEffect } from "@/hooks/use-effect";
import { signOutAndRelease } from "@/hooks/use-sign-out";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
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
  oauthConsentInfoSchema,
  getOauthHashFragment,
  getOauthClientDisplayName,
  getOauthRedirectUrl,
  getSignedOauthQueryFromHash,
} from "@/lib/oauth-provider";
import {
  type OAuthScopeGroup,
  type OAuthScopeDisplayEntry,
  type OAuthScopeDisplayGroups,
  groupOAuthScopeDisplayEntries,
  orderOAuthScopeSummary,
  toOAuthScopeDisplayEntries,
  translateOAuthScopeEntry,
  translateOAuthScopeSummary,
} from "@/lib/oauth-scopes";
import { organizationListOptions } from "@/lib/organization/queries";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";
import { optionalOrganizationSettingsOptions } from "@/lib/organization/settings-queries";
import { pageTitle } from "@/lib/page-title";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import { loadAuthContext } from "@/routes/-auth-context";
import {
  ConsentClientTiles,
  ConsentClientVerification,
} from "@/routes/consent/-components/client-identity";
import { resolveConsentClientIdentity } from "@/routes/consent/-components/client-identity.logic";
import { OAuthClientDetails } from "@/routes/consent/-components/oauth-client-details";

const SCOPE_GROUP_LABELS = {
  read: {
    group: "read",
    label: "consent.canRead",
    summary: "consent.summaryLineRead",
  },
  change: {
    group: "change",
    label: "consent.canChange",
    summary: "consent.summaryLineChange",
  },
  other: {
    group: "other",
    label: "consent.otherPermissions",
    summary: "consent.summaryLineOther",
  },
} as const satisfies {
  [Group in OAuthScopeGroup]: {
    group: Group;
    label: TranslationKey;
    summary: TranslationKey;
  };
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
  const routeActiveOrganizationId = Route.useRouteContext({
    select: (ctx) => ctx.session?.activeOrganizationId ?? null,
  });
  // The session query follows an organization switch on this page; the route
  // context only knows the organization the page loaded with.
  const sessionView = useQueryView(useQuery(sessionOptions));
  useQueryViewError(sessionView);
  const activeOrganizationId =
    (sessionView.type === "items"
      ? sessionView.items.session.activeOrganizationId
      : null) ?? routeActiveOrganizationId;
  const userId = Route.useRouteContext({ select: (ctx) => ctx.userId });
  const email = Route.useRouteContext({ select: (ctx) => ctx.user?.email });
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
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

  // Every requested scope must be disclosed, even one the server never
  // grants: unknown scopes fall back to the raw scope string instead of
  // being silently skipped.
  const scopeEntries = toOAuthScopeDisplayEntries(scopes);

  const groupedScopes = groupOAuthScopeDisplayEntries(scopeEntries);

  const handleOrganizationSwitch = async (organizationId: string) => {
    setSubmission({ status: "pending" });
    // The grant binds to the session's active organization when consent is
    // given, so switching here is what decides where the app will work.
    const outcome = await Result.tryPromise(
      async () => await authClient.organization.setActive({ organizationId }),
    );
    const error = outcome.isErr() ? outcome.error : outcome.value.error;
    if (error) {
      setSubmission({ status: "error" });
      notifyUserError(toAuthClientError(error), t("consent.error"));
      return;
    }
    await refreshAuthQueries(queryClient);
    setSubmission({ status: "idle" });
  };

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
    <main className="bg-muted/40 flex h-dvh flex-1 sm:px-6 sm:py-6">
      {/* The card never outgrows the viewport: its body scrolls and the
          decision row stays in view on a phone and on a 13-inch laptop. */}
      <Frame className="flex size-full max-h-dvh flex-col sm:m-auto sm:h-auto sm:max-h-full sm:max-w-xl">
        <ScrollArea axis="vertical" className="min-h-0 flex-1">
          <FrameHeader className="gap-4">
            <ConsentClientTiles identity={identity} />
            <div className="flex min-w-0 flex-col gap-1">
              <FrameTitle>
                <h1 className="text-balance">
                  {t("consent.connectTitle", { clientName })}
                </h1>
              </FrameTitle>
              <ConsentClientVerification identity={identity} />
            </div>
          </FrameHeader>
          <FramePanel className="flex flex-col gap-5">
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
              organizations={organizations ?? []}
            />
            {organizationName ? (
              <p className="text-muted-foreground -mt-3 text-sm text-pretty">
                {t("consent.actingAs", { clientName, organizationName })}
              </p>
            ) : null}
            <ScopeSummary groups={groupedScopes} />
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
          </FramePanel>
        </ScrollArea>
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
      </Frame>
    </main>
  );
}

type ConsentAccountRowsProps = {
  activeOrganizationId: string | null;
  disabled: boolean;
  email: string;
  onAccountSwitch: () => void;
  onOrganizationSwitch: (organizationId: string) => void;
  organizationName: string | null;
  organizations: readonly { id: string; name: string }[];
};

/** Who is granting access, and in which organization the app will work. */
function ConsentAccountRows({
  activeOrganizationId,
  disabled,
  email,
  onAccountSwitch,
  onOrganizationSwitch,
  organizationName,
  organizations,
}: ConsentAccountRowsProps) {
  const t = useTranslations();
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">{t("settings.account.title")}</dt>
      <dd className="flex min-w-0 flex-wrap items-center justify-between gap-x-3">
        <bdi className="min-w-0 break-all">{email}</bdi>
        <Button
          variant="ghost"
          className="min-h-11"
          disabled={disabled}
          onClick={onAccountSwitch}
        >
          {t("consent.useAnotherAccount")}
        </Button>
      </dd>
      {organizationName ? (
        <>
          <dt className="text-muted-foreground">{t("common.organization")}</dt>
          <dd className="min-w-0">
            {organizations.length > 1 ? (
              <Select
                disabled={disabled}
                onValueChange={(organizationId) => {
                  if (
                    typeof organizationId === "string" &&
                    organizationId !== activeOrganizationId
                  ) {
                    onOrganizationSwitch(organizationId);
                  }
                }}
                value={activeOrganizationId}
              >
                <SelectTrigger
                  aria-label={t("organization.switchOrganization")}
                  className="min-h-11 w-full"
                >
                  <SelectValue>{() => organizationName}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {organizations.map((organization) => (
                    <SelectItem key={organization.id} value={organization.id}>
                      {organization.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              <p className="flex min-h-11 items-center">{organizationName}</p>
            )}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/** Decline and Allow, outside the scrolling body so they never leave view. */
function ConsentDecisionBar({
  allowDisabled,
  hasError,
  isPending,
  onDecide,
}: {
  allowDisabled: boolean;
  hasError: boolean;
  isPending: boolean;
  onDecide: (accept: boolean) => void;
}) {
  const t = useTranslations();
  return (
    <div className="border-border/64 bg-card flex shrink-0 flex-col gap-2 border-t px-6 py-4">
      {hasError ? (
        <p className="text-destructive text-sm">{t("consent.error")}</p>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Button
          className="min-h-11 w-full"
          disabled={isPending}
          onClick={() => {
            onDecide(false);
          }}
          type="button"
          variant="outline"
        >
          {t("common.decline")}
        </Button>
        <Button
          className="min-h-11 w-full"
          disabled={isPending || allowDisabled}
          loading={isPending}
          onClick={() => {
            onDecide(true);
          }}
          type="button"
        >
          {t("consent.allow")}
        </Button>
      </div>
    </div>
  );
}

/**
 * One line per group ("Can read: documents, audit log (6)"), sensitive access
 * first and called out on its own, with the full list one click away.
 */
function ScopeSummary({ groups }: { groups: OAuthScopeDisplayGroups }) {
  const t = useTranslations();
  const format = useFormatter();
  const total = Object.values(groups).reduce(
    (sum, entries) => sum + entries.length,
    0,
  );
  const sensitive = Object.values(groups)
    .flat()
    .filter((entry) => entry.type === "known" && entry.sensitive);

  return (
    <section className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2 text-sm">
        {Object.values(SCOPE_GROUP_LABELS).map(({ group, summary }) =>
          groups[group].length > 0 ? (
            <li key={group} className="text-pretty">
              {t.rich(summary, {
                count: groups[group].length,
                items: format.list(
                  orderOAuthScopeSummary(groups[group]).map((entry) =>
                    translateOAuthScopeSummary(t, entry),
                  ),
                ),
                group: (chunks) => (
                  <span className="font-medium">{chunks}</span>
                ),
              })}
            </li>
          ) : null,
        )}
      </ul>
      {sensitive.length > 0 ? (
        <div
          className="bg-warning/8 text-foreground flex gap-2 rounded-md p-3 text-sm"
          data-slot="consent-sensitive-access"
        >
          <TriangleAlertIcon
            className="text-warning mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-medium">{t("consent.sensitiveAccess")}</p>
            <ul className="flex flex-col gap-1">
              {sensitive.map((entry) => (
                <li key={entry.type === "known" ? entry.label : entry.scope}>
                  <ScopeLabel entry={entry} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      <details className="text-sm">
        <summary className="text-muted-foreground min-h-11 cursor-pointer content-center">
          {t("consent.showAllPermissions", { count: total })}
        </summary>
        <div className="flex flex-col gap-4 pt-1 pb-2">
          {Object.values(SCOPE_GROUP_LABELS).map(({ group, label }) =>
            groups[group].length > 0 ? (
              <section key={group} className="flex flex-col gap-2">
                <h2 className="font-medium">{t(label)}</h2>
                <ul className="flex flex-col gap-2">
                  {groups[group].map((entry) => (
                    <li
                      className="flex items-start gap-2"
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
      </details>
    </section>
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
