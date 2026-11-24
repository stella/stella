import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { isSsoCallbackErrorCode } from "@stll/api-contract/sso";
import type {
  PublicSsoProviderOption,
  SsoCallbackErrorCode,
} from "@stll/api-contract/sso";
import { Button } from "@stll/ui/button";
import { Field, FieldError } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";
import { TextSeparator } from "@stll/ui/separator";

import {
  lookupSsoProviders,
  startSsoSignInRedirect,
} from "@/features/sso/sso-api";
import { authCapabilitiesOptions } from "@/lib/auth-capabilities";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";

const SSO_ERROR_KEYS = {
  sso_unavailable: "auth.sso.errors.unavailable",
  sso_protocol_unavailable: "auth.sso.errors.protocolUnavailable",
  sso_email_unverified: "auth.sso.errors.emailUnverified",
  sso_email_domain_not_allowed: "auth.sso.errors.emailDomainNotAllowed",
  sso_account_link_unavailable: "auth.sso.errors.accountLinkUnavailable",
  sso_provider_replaced: "auth.sso.errors.providerReplaced",
  sso_nonce_mismatch: "auth.sso.errors.signInFailed",
  sso_sign_in_failed: "auth.sso.errors.signInFailed",
} as const satisfies Record<SsoCallbackErrorCode, string>;

type SsoSignInSectionProps = {
  redirectTo: string;
  ssoProviderId?: string | undefined;
  ssoError?: string | undefined;
};

export const SsoSignInSection = ({
  redirectTo,
  ssoProviderId,
  ssoError,
}: SsoSignInSectionProps) => {
  const t = useTranslations();
  const capabilitiesQuery = useQuery(authCapabilitiesOptions);
  const capabilitiesView = queryView(capabilitiesQuery);
  const enterpriseSsoEnabled =
    (capabilitiesView.type === "items" &&
      capabilitiesView.items.enterpriseSso === true) ||
    ssoProviderId !== undefined;

  const isReauthPrompt = ssoProviderId === "required";
  const explicitProviderId =
    ssoProviderId !== undefined && ssoProviderId.length > 0 && !isReauthPrompt
      ? ssoProviderId
      : undefined;
  const [expanded, setExpanded] = useState(isReauthPrompt);
  const [email, setEmail] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<PublicSsoProviderOption[]>([]);
  const [busy, setBusy] = useState(false);

  const directProviderQuery = useQuery({
    queryKey: ["sso-direct-provider", explicitProviderId],
    enabled: explicitProviderId !== undefined,
    queryFn: async ({ signal }) =>
      await lookupSsoProviders(
        { by: "providerId", providerId: explicitProviderId ?? "" },
        signal,
      ),
  });
  const directProviderView = queryView(directProviderQuery);

  const errorMessage =
    ssoError !== undefined && isSsoCallbackErrorCode(ssoError)
      ? t(SSO_ERROR_KEYS[ssoError])
      : null;

  const launchProvider = async (providerId: string, loginHint?: string) => {
    setBusy(true);
    setLookupError(null);
    const origin = window.location.origin;
    const callbackURL = `${origin}${redirectTo.startsWith("/") ? redirectTo : "/"}`;
    const errorCallbackURL = `${origin}/auth?redirectTo=${encodeURIComponent(redirectTo)}`;
    const result = await startSsoSignInRedirect({
      providerId,
      callbackURL,
      errorCallbackURL,
      ...(loginHint !== undefined ? { loginHint } : {}),
    });
    if (result.isErr()) {
      setBusy(false);
      notifyUserError(result.error, t("auth.sso.errors.signInFailed"));
      return;
    }
    window.location.assign(result.value);
  };

  const handleDiscover = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed.includes("@")) {
      setLookupError(t("validation.invalidEmail"));
      return;
    }
    setBusy(true);
    setLookupError(null);
    const response = await Result.tryPromise({
      try: async () =>
        await lookupSsoProviders({
          by: "email",
          email: trimmed,
        }),
      catch: (error: unknown) => error,
    });
    if (response.isErr()) {
      setBusy(false);
      notifyUserError(response.error, t("auth.sso.errors.signInFailed"));
      return;
    }
    if (response.value.providers.length === 0) {
      setDiscovered([]);
      setLookupError(t("auth.sso.noProviderForDomain"));
      setBusy(false);
      return;
    }
    if (response.value.providers.length === 1) {
      const only = response.value.providers.at(0);
      if (only !== undefined) {
        await launchProvider(only.providerId, trimmed);
        return;
      }
    }
    setDiscovered(response.value.providers);
    setBusy(false);
  };

  if (!enterpriseSsoEnabled && errorMessage === null) {
    return null;
  }

  const directProvider =
    directProviderView.type === "items"
      ? directProviderView.items.providers.at(0)
      : undefined;
  const busyReason = t("common.loading");

  return (
    <div className="mt-4 w-full max-w-sm space-y-3">
      {errorMessage !== null && (
        <div
          className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
          role="alert"
        >
          {errorMessage}
        </div>
      )}

      {directProvider !== undefined && (
        <div className="border-border bg-card space-y-2 rounded-lg border p-3">
          <p className="text-foreground text-sm font-medium">
            {directProvider.displayName ?? t("auth.sso.title")}
          </p>
          <Button
            className="w-full"
            disabled={busy}
            disabledReason={busyReason}
            onClick={() => {
              detached(
                launchProvider(directProvider.providerId),
                "sso-sign-in.launch-direct",
              );
            }}
            type="button"
          >
            {t("auth.sso.continueWithSso")}
          </Button>
        </div>
      )}

      {enterpriseSsoEnabled && directProvider === undefined && (
        <>
          <TextSeparator>{t("auth.sso.or")}</TextSeparator>
          {!expanded ? (
            <Button
              className="w-full"
              onClick={() => setExpanded(true)}
              type="button"
              variant="outline"
            >
              {t("auth.sso.signInWithSso")}
            </Button>
          ) : (
            <Form className="space-y-2" onSubmit={handleDiscover}>
              <Field invalid={lookupError !== null}>
                <Input
                  autoComplete="email"
                  disabled={busy}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setLookupError(null);
                  }}
                  placeholder={t("auth.sso.workEmailPlaceholder")}
                  type="email"
                  value={email}
                />
                {lookupError !== null && <FieldError>{lookupError}</FieldError>}
              </Field>
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  disabled={busy}
                  disabledReason={busyReason}
                  type="submit"
                >
                  {t("auth.sso.continueWithSso")}
                </Button>
                <Button
                  disabled={busy}
                  disabledReason={busyReason}
                  onClick={() => {
                    setExpanded(false);
                    setDiscovered([]);
                    setLookupError(null);
                  }}
                  type="button"
                  variant="ghost"
                >
                  {t("common.cancel")}
                </Button>
              </div>
              {discovered.length > 1 && (
                <div className="space-y-1.5 pt-1">
                  {discovered.map((provider) => (
                    <Button
                      className="w-full"
                      disabled={busy}
                      disabledReason={busyReason}
                      key={provider.providerId}
                      onClick={() => {
                        detached(
                          launchProvider(provider.providerId, email.trim()),
                          "sso-sign-in.launch-discovered",
                        );
                      }}
                      type="button"
                      variant="outline"
                    >
                      {provider.displayName ?? provider.providerId}
                    </Button>
                  ))}
                </div>
              )}
            </Form>
          )}
        </>
      )}
    </div>
  );
};
