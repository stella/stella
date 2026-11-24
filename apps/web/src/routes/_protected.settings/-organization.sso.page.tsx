import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type {
  OrganizationSsoDomainSummary,
  OrganizationSsoPolicyRequirement,
  OrganizationSsoProviderSummary,
  TestOidcSsoProviderResponse,
} from "@stll/api-contract/sso";
import { Badge } from "@stll/ui/badge";
import { Button } from "@stll/ui/button";
import { Field, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";
import { Switch } from "@stll/ui/switch";
import { stellaToast } from "@stll/ui/toast";
import { TruncatedText } from "@stll/ui/truncated-text";

import { CopyControl } from "@/components/copy-control";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { SecretInput } from "@/components/secret-input";
import {
  addOrgSsoDomain,
  fetchOrgSsoSettings,
  probeOidcSsoProvider,
  registerOidcSsoProvider,
  removeOrgSsoDomain,
  removeOrgSsoProvider,
  saveOrgSsoPolicy,
  verifyOrgSsoDomain,
} from "@/features/sso/sso-api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";

import { OrganizationSsoPageShell } from "./-organization.sso.pending";

const SSO_SETTINGS_QUERY_KEY = ["org-sso-settings"] as const;

const IDP_PRESETS = [
  {
    id: "okta",
    label: "Okta",
    issuerPlaceholder: "https://your-org.okta.com/oauth2/default",
  },
  {
    id: "entra",
    label: "Microsoft Entra ID",
    issuerPlaceholder: "https://login.microsoftonline.com/<tenant-id>/v2.0",
  },
  {
    id: "google",
    label: "Google Workspace",
    issuerPlaceholder: "https://accounts.google.com",
  },
  {
    id: "ping",
    label: "Ping Identity",
    issuerPlaceholder: "https://auth.pingone.com/<env-id>/as",
  },
] as const;

const CopyValueRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between gap-2 text-xs">
    <div className="text-muted-foreground min-w-0 flex-1">
      <span>{label}: </span>
      <TruncatedText render={<code />}>{value}</TruncatedText>
    </div>
    <CopyControl size="xs" text={value} variant="ghost" />
  </div>
);

const AddOidcProviderForm = ({
  onCreated,
  onCancel,
}: {
  onCreated: () => Promise<void>;
  onCancel: () => void;
}) => {
  const t = useTranslations();
  const [displayName, setDisplayName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [discoveryEndpoint, setDiscoveryEndpoint] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [domainsInput, setDomainsInput] = useState("");
  const [discoveryProbe, setDiscoveryProbe] =
    useState<TestOidcSsoProviderResponse | null>(null);

  const testDiscoveryMutation = useMutation({
    mutationFn: async () =>
      await probeOidcSsoProvider({
        issuer: issuer.trim(),
        ...(discoveryEndpoint.trim() !== ""
          ? { discoveryEndpoint: discoveryEndpoint.trim() }
          : {}),
      }),
    onSuccess: (result) => {
      setDiscoveryProbe(result);
      stellaToast.add({
        title: t("settings.organization.sso.discoverySuccess"),
        type: "success",
      });
    },
    onError: (error) => {
      setDiscoveryProbe(null);
      notifyUserError(error, t("settings.organization.sso.discoveryFailed"));
    },
  });

  const createProviderMutation = useMutation({
    mutationFn: async () => {
      const domains = domainsInput
        .split(/[,\s]+/u)
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
      return await registerOidcSsoProvider({
        displayName: displayName.trim(),
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        clientSecret,
        ...(discoveryEndpoint.trim() !== ""
          ? { discoveryEndpoint: discoveryEndpoint.trim() }
          : {}),
        domains,
      });
    },
    onSuccess: async () => {
      await onCreated();
      stellaToast.add({
        title: t("settings.organization.sso.providerAdded"),
        type: "success",
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  return (
    <div className="border-border bg-muted/30 rounded-lg border p-3">
      <Form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          createProviderMutation.mutate();
        }}
      >
        <div className="flex flex-wrap gap-1.5">
          {IDP_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              onClick={() => {
                setDisplayName(preset.label);
                if (issuer.trim() === "") {
                  setIssuer(preset.issuerPlaceholder);
                }
              }}
              size="xs"
              type="button"
              variant="outline"
            >
              {preset.label}
            </Button>
          ))}
        </div>

        <Field>
          <FieldLabel>
            {t("settings.organization.sso.displayNameLabel")}
          </FieldLabel>
          <Input
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Okta"
            required
            value={displayName}
          />
        </Field>

        <Field>
          <FieldLabel>{t("settings.organization.sso.issuerLabel")}</FieldLabel>
          <div className="flex gap-2">
            <Input
              className="flex-1"
              onChange={(e) => {
                setIssuer(e.target.value);
                setDiscoveryProbe(null);
              }}
              placeholder="https://your-org.okta.com/oauth2/default"
              required
              type="url"
              value={issuer}
            />
            <Button
              disabled={testDiscoveryMutation.isPending || issuer.trim() === ""}
              disabledReason={t("settings.organization.sso.issuerLabel")}
              onClick={() => testDiscoveryMutation.mutate()}
              type="button"
              variant="outline"
            >
              {t("settings.organization.sso.testDiscovery")}
            </Button>
          </div>
        </Field>

        {discoveryProbe !== null && (
          <p className="text-muted-foreground text-xs">
            {t("settings.organization.sso.discoveryVerifiedDetail", {
              issuer: discoveryProbe.issuer,
            })}
          </p>
        )}

        <Field>
          <FieldLabel>
            {t("settings.organization.sso.discoveryEndpointLabel")}
          </FieldLabel>
          <Input
            onChange={(e) => setDiscoveryEndpoint(e.target.value)}
            placeholder="https://.../.well-known/openid-configuration"
            type="url"
            value={discoveryEndpoint}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel>
              {t("settings.organization.sso.clientIdLabel")}
            </FieldLabel>
            <Input
              onChange={(e) => setClientId(e.target.value)}
              required
              value={clientId}
            />
          </Field>
          <Field>
            <FieldLabel>
              {t("settings.organization.sso.clientSecretLabel")}
            </FieldLabel>
            <SecretInput
              autoComplete="new-password"
              onChange={(e) => setClientSecret(e.target.value)}
              required
              value={clientSecret}
            />
          </Field>
        </div>

        <Field>
          <FieldLabel>{t("settings.organization.sso.domainsLabel")}</FieldLabel>
          <Input
            onChange={(e) => setDomainsInput(e.target.value)}
            placeholder="acme.com, acme.eu"
            required
            value={domainsInput}
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} type="button" variant="ghost">
            {t("common.cancel")}
          </Button>
          <Button
            disabled={createProviderMutation.isPending}
            disabledReason={t("common.loading")}
            type="submit"
          >
            {t("common.save")}
          </Button>
        </div>
      </Form>
    </div>
  );
};

const OidcProvidersSection = ({
  providers,
  onChanged,
}: {
  providers: readonly OrganizationSsoProviderSummary[];
  onChanged: () => Promise<void>;
}) => {
  const t = useTranslations();
  const [showAddProvider, setShowAddProvider] = useState(false);

  const deleteProviderMutation = useMutation({
    mutationFn: async (providerId: string) =>
      await removeOrgSsoProvider(providerId),
    onSuccess: async () => {
      await onChanged();
      stellaToast.add({
        title: t("settings.organization.sso.providerDeleted"),
        type: "success",
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  return (
    <section className="border-border bg-card space-y-4 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-foreground text-sm font-medium">
            {t("settings.organization.sso.providersTitle")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("settings.organization.sso.providersDescription")}
          </p>
        </div>
        {!showAddProvider && (
          <Button
            onClick={() => setShowAddProvider(true)}
            size="sm"
            type="button"
          >
            {t("settings.organization.sso.addProvider")}
          </Button>
        )}
      </div>

      {showAddProvider && (
        <AddOidcProviderForm
          onCancel={() => setShowAddProvider(false)}
          onCreated={() => {
            setShowAddProvider(false);
            return onChanged();
          }}
        />
      )}

      {providers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("settings.organization.sso.noProviders")}
        </p>
      ) : (
        <div className="space-y-3">
          {providers.map((provider) => (
            <div
              className="border-border space-y-2 rounded-lg border p-3"
              key={provider.id}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-foreground text-sm font-medium">
                      {provider.displayName ?? provider.providerId}
                    </span>
                    <Badge>{provider.protocol.toUpperCase()}</Badge>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {provider.issuer}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {provider.domains.join(", ")}
                  </p>
                </div>
                <Button
                  disabled={deleteProviderMutation.isPending}
                  disabledReason={t("common.loading")}
                  onClick={() =>
                    deleteProviderMutation.mutate(provider.providerId)
                  }
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  {t("common.delete")}
                </Button>
              </div>

              <div className="grid gap-1.5">
                <CopyValueRow
                  label={t("settings.organization.sso.callbackUrlLabel")}
                  value={provider.callbackUrl}
                />
                <CopyValueRow
                  label={t("settings.organization.sso.launchUrlLabel")}
                  value={provider.launchUrl}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

const VerifiedDomainsSection = ({
  domains,
  onChanged,
}: {
  domains: readonly OrganizationSsoDomainSummary[];
  onChanged: () => Promise<void>;
}) => {
  const t = useTranslations();
  const [newDomain, setNewDomain] = useState("");

  const createDomainMutation = useMutation({
    mutationFn: async (domain: string) => await addOrgSsoDomain(domain),
    onSuccess: async () => {
      await onChanged();
      setNewDomain("");
      stellaToast.add({
        title: t("settings.organization.sso.domainAdded"),
        type: "success",
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  const verifyDomainMutation = useMutation({
    mutationFn: async (domainId: string) => await verifyOrgSsoDomain(domainId),
    onSuccess: async ({ verified }) => {
      await onChanged();
      stellaToast.add({
        title: verified
          ? t("settings.organization.sso.domainVerified")
          : t("settings.organization.sso.domainRecordNotFound"),
        type: verified ? "success" : "warning",
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  const deleteDomainMutation = useMutation({
    mutationFn: async (domainId: string) => await removeOrgSsoDomain(domainId),
    onSuccess: async () => {
      await onChanged();
      stellaToast.add({
        title: t("settings.organization.sso.domainDeleted"),
        type: "success",
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  return (
    <section className="border-border bg-card space-y-4 rounded-xl border p-4">
      <div>
        <h2 className="text-foreground text-sm font-medium">
          {t("settings.organization.sso.domainsTitle")}
        </h2>
        <p className="text-muted-foreground text-xs">
          {t("settings.organization.sso.domainsDescription")}
        </p>
      </div>

      <Form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (newDomain.trim() !== "") {
            createDomainMutation.mutate(newDomain.trim());
          }
        }}
      >
        <Input
          className="flex-1"
          onChange={(e) => setNewDomain(e.target.value)}
          placeholder="acme.com"
          value={newDomain}
        />
        <Button
          disabled={createDomainMutation.isPending || newDomain.trim() === ""}
          disabledReason={t("settings.organization.sso.addDomain")}
          type="submit"
          variant="outline"
        >
          {t("settings.organization.sso.addDomain")}
        </Button>
      </Form>

      {domains.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("settings.organization.sso.noDomains")}
        </p>
      ) : (
        <div className="space-y-3">
          {domains.map((domain) => (
            <div
              className="border-border space-y-2 rounded-lg border p-3"
              key={domain.id}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-foreground text-sm font-medium">
                    {domain.domain}
                  </span>
                  <Badge>
                    {domain.status === "verified"
                      ? t("settings.organization.sso.statusVerified")
                      : t("settings.organization.sso.statusPending")}
                  </Badge>
                </div>
                <div className="flex items-center gap-1.5">
                  {domain.status === "pending" && (
                    <Button
                      disabled={verifyDomainMutation.isPending}
                      disabledReason={t("common.loading")}
                      onClick={() => verifyDomainMutation.mutate(domain.id)}
                      size="xs"
                      type="button"
                    >
                      {t("settings.organization.sso.verifyDomain")}
                    </Button>
                  )}
                  <Button
                    disabled={deleteDomainMutation.isPending}
                    disabledReason={t("common.loading")}
                    onClick={() => deleteDomainMutation.mutate(domain.id)}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    {t("common.delete")}
                  </Button>
                </div>
              </div>

              {domain.status === "pending" && (
                <div className="bg-muted/40 space-y-1 rounded-sm p-2 text-xs">
                  <p className="text-muted-foreground">
                    {t("settings.organization.sso.dnsTxtInstructions")}
                  </p>
                  <CopyValueRow
                    label={`TXT ${domain.txtHost}`}
                    value={domain.txtValue}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

export const OrganizationSsoPage = () => {
  const t = useTranslations();
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: SSO_SETTINGS_QUERY_KEY,
    queryFn: async ({ signal }) => await fetchOrgSsoSettings(signal),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: SSO_SETTINGS_QUERY_KEY });
  };

  const policyMutation = useMutation({
    mutationFn: async (requirement: OrganizationSsoPolicyRequirement) =>
      await saveOrgSsoPolicy(requirement),
    onSuccess: async () => {
      await invalidate();
      stellaToast.add({
        title: t("settings.organization.sso.policyUpdated"),
        type: "success",
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  const view = queryView(settingsQuery);
  if (view.type !== "items") {
    return (
      <OrganizationSsoPageShell>
        <QueryViewFeedback view={view} />
      </OrganizationSsoPageShell>
    );
  }

  const settings = view.items;
  const isRequired = settings.requirement === "required";

  return (
    <OrganizationSsoPageShell>
      <div>
        <h1 className="text-foreground text-lg font-semibold">
          {t("settings.organization.sso.title")}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {t("settings.organization.sso.description")}
        </p>
      </div>

      <section className="border-border bg-card rounded-xl border p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-foreground text-sm font-medium">
              {t("settings.organization.sso.requireSsoTitle")}
            </h2>
            <p className="text-muted-foreground text-xs">
              {t("settings.organization.sso.requireSsoDescription")}
            </p>
          </div>
          <Switch
            checked={isRequired}
            disabled={
              policyMutation.isPending ||
              (!isRequired && settings.providers.length === 0)
            }
            onCheckedChange={(checked) => {
              policyMutation.mutate(checked ? "required" : "optional");
            }}
          />
        </div>
      </section>

      <OidcProvidersSection
        onChanged={invalidate}
        providers={settings.providers}
      />
      <VerifiedDomainsSection
        domains={settings.domains}
        onChanged={invalidate}
      />
    </OrganizationSsoPageShell>
  );
};
