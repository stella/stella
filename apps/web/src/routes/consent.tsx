import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stella/ui/components/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stella/ui/components/frame";
import { toastManager } from "@stella/ui/components/toast";

import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import {
  getOauthClientDisplayName,
  getOauthRedirectUrl,
} from "@/lib/oauth-provider";
import { pageTitle } from "@/lib/page-title";

const searchSchema = v.object({
  client_id: v.optional(v.string()),
  scope: v.optional(v.string()),
});

export const Route = createFileRoute("/consent")({
  head: () => ({
    meta: [{ title: pageTitle("consent.title") }],
  }),
  validateSearch: searchSchema,
  beforeLoad: ({ context, location }) => {
    if (!context.session) {
      throw redirect({
        to: "/auth",
        search: {
          redirectTo: location.pathname + location.searchStr,
        },
        replace: true,
      });
    }
  },
  component: ConsentPage,
});

const SCOPE_LABELS = {
  "stella:search": "consent.scopeSearch",
  "stella:read": "consent.scopeRead",
  email: "consent.scopeProfile",
  openid: "consent.scopeProfile",
  profile: "consent.scopeProfile",
} as const;

type ScopeKey = keyof typeof SCOPE_LABELS;

const isScopeKey = (scope: string): scope is ScopeKey => scope in SCOPE_LABELS;

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

  const scopes = scope?.split(" ").filter(Boolean) ?? [];
  const clientName =
    getOauthClientDisplayName(clientQuery.data) ??
    t("consent.defaultClientName");
  const organizationName =
    organizations?.find(
      (organization) => organization.id === activeOrganizationId,
    )?.name ?? null;

  const uniqueLabels = new Map<string, string>();
  for (const requestedScope of scopes) {
    if (!isScopeKey(requestedScope)) {
      continue;
    }

    const label = SCOPE_LABELS[requestedScope];
    if (!uniqueLabels.has(label)) {
      uniqueLabels.set(label, requestedScope);
    }
  }

  const handleConsent = async (accept: boolean) => {
    setIsPending(true);
    setHasError(false);

    const result = await authClient.oauth2.consent({ accept });
    if (result.error) {
      setHasError(true);
      setIsPending(false);
      toastManager.add({
        title: result.error.message ?? t("consent.error"),
        type: "error",
      });
      return;
    }

    const redirectUrl = getOauthRedirectUrl(result.data);
    if (!redirectUrl) {
      setHasError(true);
      setIsPending(false);
      toastManager.add({
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
                {t("consent.organization")}
              </p>
              <p className="text-sm font-medium">{organizationName}</p>
            </div>
          ) : null}
          {uniqueLabels.size > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground text-sm">
                {t("consent.permissions")}
              </p>
              <ul className="flex flex-col gap-1.5">
                {[...uniqueLabels.keys()].map((label) => (
                  <li
                    className="text-foreground flex items-start gap-2 text-sm"
                    key={label}
                  >
                    <span className="text-muted-foreground mt-0.5">&bull;</span>
                    {/* SAFETY: label comes from SCOPE_LABELS, whose values are
                        valid translation keys, but use-intl does not accept a
                        computed nested key type. */}
                    {/* eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion */}
                    {t(label as never)}
                  </li>
                ))}
              </ul>
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
                // eslint-disable-next-line typescript/no-floating-promises
                handleConsent(true);
              }}
              type="button"
            >
              {t("consent.allow")}
            </Button>
            <Button
              className="w-full"
              disabled={isPending}
              onClick={() => {
                // eslint-disable-next-line typescript/no-floating-promises
                handleConsent(false);
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
