import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";
import { stellaToast } from "@stll/ui/toast";

import { StellaMark } from "@/components/stella-mark";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { toAuthClientError } from "@/lib/errors/auth";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import {
  getOauthHashFragment,
  getOauthClientDisplayName,
  getOauthRedirectUrl,
  getSignedOauthQueryFromHash,
} from "@/lib/oauth-provider";
import type { OAuthScopeDisplayEntry } from "@/lib/oauth-scopes";
import {
  toOAuthScopeDisplayEntries,
  translateOAuthScopeEntry,
} from "@/lib/oauth-scopes";
import { managementRoles } from "@/lib/organization/consts";
import { pageTitle } from "@/lib/page-title";
import { loadAuthContext } from "@/routes/-auth-context";

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

    return authContext;
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
  const [isPending, setIsPending] = useState(false);
  const [hasError, setHasError] = useState(false);
  const { data: organizations } = authClient.useListOrganizations();
  const { data: currentUserRole } = useQuery({
    ...roleOptions,
    enabled: activeOrganizationId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const canManageOrganization =
    currentUserRole !== undefined && managementRoles.includes(currentUserRole);

  const clientQuery = useQuery({
    enabled: clientId !== null,
    queryKey: ["oauth-client-public", clientId],
    queryFn: async () => {
      if (!clientId) {
        return null;
      }

      const result = await authClient.oauth2.publicClient({
        query: { client_id: clientId },
      });

      if (result.error) {
        throw toAuthClientError(result.error);
      }

      return result.data;
    },
  });

  const jurisdictionsQuery = useQuery({
    enabled: activeOrganizationId !== null && canManageOrganization,
    queryKey: ["consent-practice-jurisdictions", activeOrganizationId],
    queryFn: async ({ signal }) => {
      const response = await api["organization-settings"].get({
        fetch: { signal },
      });
      return unwrapEden(response).practiceJurisdictions;
    },
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

  const handleConsent = async (accept: boolean) => {
    setIsPending(true);
    setHasError(false);

    const result = await authClient.oauth2.consent({ accept });
    if (result.error) {
      setHasError(true);
      setIsPending(false);
      stellaToast.add({
        title: userErrorFromThrown(
          toAuthClientError(result.error),
          t("consent.error"),
        ),
        type: "error",
      });
      return;
    }

    const redirectUrl = getOauthRedirectUrl(result.data);
    if (!redirectUrl) {
      setHasError(true);
      setIsPending(false);
      stellaToast.add({
        title: t("consent.error"),
        type: "error",
      });
      return;
    }

    window.location.href = redirectUrl;
  };

  return (
    <main className="flex flex-1 overflow-y-auto px-4 py-6 sm:px-6 sm:py-10">
      <Frame className="m-auto w-full max-w-2xl">
        <FrameHeader className="gap-4 sm:flex-row sm:items-start">
          <div className="bg-background outline-foreground/8 flex size-11 shrink-0 items-center justify-center rounded-xl shadow-xs outline outline-1">
            <StellaMark className="text-foreground size-6" />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <FrameTitle className="text-base">
              <h1>{t("consent.title")}</h1>
            </FrameTitle>
            <FrameDescription className="text-pretty">
              {t("consent.description", { clientName })}
            </FrameDescription>
          </div>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-5 p-4 sm:p-5">
          {organizationName ? (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-lg px-3 py-2.5">
              <p className="text-muted-foreground text-sm">
                {t("common.organization")}
              </p>
              <p className="text-sm font-medium">{organizationName}</p>
            </div>
          ) : null}
          {scopeEntries.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground text-sm">
                {t("consent.permissions")}
              </p>
              <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {scopeEntries.map((entry) => (
                  <li
                    className="text-foreground flex items-start gap-2 text-sm"
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
            </div>
          ) : null}
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
          <div className="border-border/64 flex flex-col gap-2 border-t pt-4 sm:flex-row sm:justify-end">
            <Button
              className="w-full sm:w-auto"
              disabled={isPending}
              onClick={() => {
                detached(handleConsent(false), "consent.decline");
              }}
              type="button"
              variant="ghost"
            >
              {t("common.decline")}
            </Button>
            <Button
              className="w-full sm:w-auto"
              disabled={isPending}
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

  return translateOAuthScopeEntry(t, entry);
}
