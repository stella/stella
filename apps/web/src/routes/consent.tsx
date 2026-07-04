import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import type { McpOAuthScope } from "@stll/api/types";
import { Button } from "@stll/ui/components/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/components/frame";
import { stellaToast } from "@stll/ui/components/toast";

import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { toAPIError, toAuthClientError } from "@/lib/errors";
import {
  getOauthClientDisplayName,
  getOauthRedirectUrl,
} from "@/lib/oauth-provider";
import { pageTitle } from "@/lib/page-title";
import { loadAuthContext } from "@/routes/-auth-context";
import { roleOptions } from "@/routes/-queries";
import { managementRoles } from "@/routes/_protected.organization/-consts";

const searchSchema = v.object({
  client_id: v.optional(v.string()),
  scope: v.optional(v.string()),
});

export const Route = createFileRoute("/consent")({
  validateSearch: searchSchema,
  beforeLoad: async ({ context, location }) => {
    const authContext = await loadAuthContext(context.queryClient);

    if (!authContext.session) {
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

// `satisfies Record<McpOAuthScope, TranslationKey>` makes this exhaustive
// over every scope the OAuth provider can grant (`MCP_OAUTH_SCOPES` in
// `apps/api/src/mcp/constants.ts`): adding a new grantable scope without a
// consent label here fails the build instead of silently skipping
// disclosure. The unknown-scope fallback below is a second, runtime-only
// layer for scopes a client requests that the server does not grant.
const SCOPE_LABELS = {
  "stella:search": "consent.scopeSearch",
  "stella:read": "consent.scopeRead",
  "stella:templates": "consent.scopeTemplates",
  "stella:documents_write": "consent.scopeDocumentsWrite",
  "stella:matters_write": "consent.scopeMattersWrite",
  "stella:skills": "consent.scopeSkills",
  "stella:external_mcps": "consent.scopeExternalMcps",
  "stella:search_anonymized": "consent.scopeSearchAnonymized",
  "stella:read_anonymized": "consent.scopeReadAnonymized",
  "stella:templates_anonymized": "consent.scopeTemplatesAnonymized",
  "stella:onboarding": "consent.scopeOnboarding",
  email: "consent.scopeProfile",
  openid: "consent.scopeProfile",
  profile: "consent.scopeProfile",
} as const satisfies Record<McpOAuthScope, TranslationKey>;

type ScopeKey = keyof typeof SCOPE_LABELS;

const isScopeKey = (scope: string): scope is ScopeKey => scope in SCOPE_LABELS;

type ScopeDisplayEntry =
  | { label: TranslationKey; type: "known" }
  | { scope: string; type: "unknown" };

function ConsentPage() {
  const t = useTranslations();
  const clientId = Route.useSearch({
    select: (search) => search.client_id ?? null,
  });
  const scope = Route.useSearch({
    select: (search) => search.scope,
  });
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
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data.practiceJurisdictions;
    },
  });
  const showJurisdictionsNotice =
    canManageOrganization &&
    jurisdictionsQuery.data !== undefined &&
    jurisdictionsQuery.data.length === 0;

  const scopes = scope?.split(" ").filter(Boolean) ?? [];
  const clientName =
    getOauthClientDisplayName(clientQuery.data) ??
    t("consent.defaultClientName");
  const organizationName =
    organizations?.find(
      (organization) => organization.id === activeOrganizationId,
    )?.name ?? null;

  // Every requested scope must be disclosed, even one the server never
  // grants (`isScopeKey` false): unknown scopes fall back to the raw scope
  // string instead of being silently skipped.
  const scopeEntries: ScopeDisplayEntry[] = [];
  const seenLabels = new Set<TranslationKey>();
  const seenUnknownScopes = new Set<string>();
  for (const requestedScope of scopes) {
    if (isScopeKey(requestedScope)) {
      const label = SCOPE_LABELS[requestedScope];
      if (!seenLabels.has(label)) {
        seenLabels.add(label);
        scopeEntries.push({ label, type: "known" });
      }
      continue;
    }

    if (!seenUnknownScopes.has(requestedScope)) {
      seenUnknownScopes.add(requestedScope);
      scopeEntries.push({ scope: requestedScope, type: "unknown" });
    }
  }

  const handleConsent = async (accept: boolean) => {
    setIsPending(true);
    setHasError(false);

    const result = await authClient.oauth2.consent({ accept });
    if (result.error) {
      setHasError(true);
      setIsPending(false);
      stellaToast.add({
        title: result.error.message ?? t("consent.error"),
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
    <div className="flex flex-1 items-center justify-center">
      <Frame className="w-full max-w-sm">
        <FrameHeader>
          <FrameTitle>{t("consent.title")}</FrameTitle>
          <FrameDescription>
            {t("consent.description", { clientName })}
          </FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-4">
          {organizationName ? (
            <div className="flex flex-col gap-1">
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
              <ul className="flex flex-col gap-1.5">
                {scopeEntries.map((entry) => (
                  <li
                    className="text-foreground flex items-start gap-2 text-sm"
                    key={entry.type === "known" ? entry.label : entry.scope}
                  >
                    <span className="text-muted-foreground mt-0.5">&bull;</span>
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
          <div className="flex flex-col gap-2">
            <Button
              className="w-full"
              disabled={isPending}
              loading={isPending}
              onClick={() => {
                void handleConsent(true);
              }}
              type="button"
            >
              {t("consent.allow")}
            </Button>
            <Button
              className="w-full"
              disabled={isPending}
              onClick={() => {
                void handleConsent(false);
              }}
              type="button"
              variant="outline"
            >
              {t("consent.deny")}
            </Button>
          </div>
        </FramePanel>
      </Frame>
    </div>
  );
}

function ScopeLabel({ entry }: { entry: ScopeDisplayEntry }) {
  const t = useTranslations();

  if (entry.type === "unknown") {
    return entry.scope;
  }

  // SAFETY: SCOPE_LABELS `satisfies Record<McpOAuthScope, TranslationKey>`
  // enforces at compile time that every value is a valid key. The `as never`
  // is required only because use-intl's `t()` overloads bind tighter for
  // literal keys; a non-literal `TranslationKey` is rejected by the no-args
  // overload.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return t(entry.label as never);
}
