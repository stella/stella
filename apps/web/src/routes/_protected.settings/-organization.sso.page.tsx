import { useState } from "react";

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  ORGANIZATION_SSO_PROVISIONING_MODES,
  updateOrganizationSsoPolicyBodySchema,
} from "@stll/api-contract/sso";
import type {
  OrganizationSsoDomainSummary,
  OrganizationSsoPendingMemberSummary,
  OrganizationSsoProviderSummary,
  OrganizationSsoProvisioningMode,
  TestOidcSsoProviderResponse,
  UpdateOrganizationSsoPolicyBody,
} from "@stll/api-contract/sso";
import { Badge } from "@stll/ui/badge";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Field, FieldLabel } from "@stll/ui/field";
import { openFilePicker } from "@stll/ui/file-picker";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";
import { Switch } from "@stll/ui/switch";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";
import { TruncatedText } from "@stll/ui/truncated-text";

import { CopyControl } from "@/components/copy-control";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { SecretInput } from "@/components/secret-input";
import {
  addOrgSsoDomain,
  approveOrgSsoPendingMember,
  fetchOrgSsoSettings,
  importSamlSsoMetadata,
  probeOidcSsoProvider,
  registerOidcSsoProvider,
  registerSamlSsoProvider,
  rejectOrgSsoPendingMember,
  removeOrgSsoDomain,
  removeOrgSsoProvider,
  saveOrgSsoPolicy,
  verifyOrgSsoDomain,
} from "@/features/sso/sso-api";
import { browserAuthBaseUrl } from "@/lib/api-url";
import { APIError } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import {
  resourceMutation,
  resourceQueryOptions,
} from "@/lib/workspace-realtime";

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
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [discoveryEndpoint, setDiscoveryEndpoint] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [domainsInput, setDomainsInput] = useState("");
  const [discoveryProbe, setDiscoveryProbe] =
    useState<TestOidcSsoProviderResponse | null>(null);

  const testDiscoveryMutationFn = resourceMutation({
    mutation: "probeOidcSsoProvider",
    queryClient,
    scope: { type: "organization" },
    mutationFn: async () =>
      await probeOidcSsoProvider({
        issuer: issuer.trim(),
        ...(discoveryEndpoint.trim() !== ""
          ? { discoveryEndpoint: discoveryEndpoint.trim() }
          : {}),
      }),
  });
  const testDiscoveryMutation = useMutation({
    mutationFn: testDiscoveryMutationFn,
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
    mutationFn: resourceMutation({
      mutation: "registerOidcSsoProvider",
      queryClient,
      scope: { type: "organization" },
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
    }),
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
          <FieldLabel>{t("common.displayName")}</FieldLabel>
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
          <Button
            disabled={createProviderMutation.isPending}
            disabledReason={t("common.loading")}
            onClick={onCancel}
            type="button"
            variant="ghost"
          >
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

const AddSamlProviderForm = ({
  onCreated,
  onCancel,
}: {
  onCreated: () => Promise<void>;
  onCancel: () => void;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [draftProviderId] = useState(() => {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const suffix = Array.from(bytes, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    return `sso_saml_${suffix}`;
  });
  let authBaseUrl = browserAuthBaseUrl();
  while (authBaseUrl.endsWith("/")) {
    authBaseUrl = authBaseUrl.slice(0, -1);
  }
  const draftAcsUrl = `${authBaseUrl}/sso/saml2/sp/acs/${encodeURIComponent(draftProviderId)}`;
  const draftSpMetadataUrl = `${authBaseUrl}/sso/saml2/sp/metadata?providerId=${encodeURIComponent(draftProviderId)}`;
  const [displayName, setDisplayName] = useState("");
  const [metadataUrl, setMetadataUrl] = useState("");
  const [issuer, setIssuer] = useState("");
  const [entryPoint, setEntryPoint] = useState("");
  const [cert, setCert] = useState("");
  const [domainsInput, setDomainsInput] = useState("");

  const importMetadataMutationFn = resourceMutation({
    mutation: "importSamlSsoMetadata",
    queryClient,
    scope: { type: "organization" },
    mutationFn: async (
      input:
        { source: "url"; metadataUrl: string } | { source: "xml"; xml: string },
    ) => await importSamlSsoMetadata(input),
  });
  const importMetadataMutation = useMutation({
    mutationFn: importMetadataMutationFn,
    onSuccess: (parsed) => {
      setIssuer(parsed.issuer);
      setEntryPoint(parsed.entryPoint);
      setCert(parsed.cert);
      stellaToast.add({
        title: t("settings.organization.sso.samlMetadataImported"),
        type: "success",
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  const handleMetadataFile = async (file: File | undefined) => {
    if (file === undefined) {
      return;
    }
    if (file.size > 512 * 1024) {
      const message = t("settings.organization.sso.samlMetadataFileTooLarge");
      notifyUserError(new APIError({ status: 400, message }), message);
      return;
    }
    const xml = await file.text();
    importMetadataMutation.mutate({ source: "xml", xml });
  };

  const handleOpenMetadataPicker = () => {
    openFilePicker({
      accept: ".xml,application/xml,text/xml",
      onPick: ([file]) => {
        handleMetadataFile(file).catch((error: unknown) => {
          notifyUserError(error, t("errors.actionFailed"));
        });
      },
    });
  };

  const createProviderMutation = useMutation({
    mutationFn: resourceMutation({
      mutation: "registerSamlSsoProvider",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async () => {
        const domains = domainsInput
          .split(/[,\s]+/u)
          .map((d) => d.trim())
          .filter((d) => d.length > 0);
        return await registerSamlSsoProvider({
          providerId: draftProviderId,
          displayName: displayName.trim(),
          issuer: issuer.trim(),
          entryPoint: entryPoint.trim(),
          cert: cert.trim(),
          domains,
        });
      },
    }),
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
        <div className="border-border/60 bg-background/60 space-y-2 rounded-md border p-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">
              {t("settings.organization.sso.spMetadataUrlLabel")}:
            </span>
            <code className="bg-muted rounded-sm px-1.5 py-0.5 break-all">
              {draftSpMetadataUrl}
            </code>
            <CopyControl size="xs" text={draftSpMetadataUrl} variant="ghost" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">
              {t("settings.organization.sso.acsUrlLabel")}:
            </span>
            <code className="bg-muted rounded-sm px-1.5 py-0.5 break-all">
              {draftAcsUrl}
            </code>
            <CopyControl size="xs" text={draftAcsUrl} variant="ghost" />
          </div>
        </div>
        <Field>
          <FieldLabel>{t("common.displayName")}</FieldLabel>
          <Input
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Okta SAML"
            required
            value={displayName}
          />
        </Field>
        <Field>
          <FieldLabel>
            {t("settings.organization.sso.samlMetadataImportLabel")}
          </FieldLabel>
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-48 flex-1"
              onChange={(e) => setMetadataUrl(e.target.value)}
              placeholder="https://.../federationmetadata.xml"
              type="url"
              value={metadataUrl}
            />
            <Button
              disabled={
                importMetadataMutation.isPending || metadataUrl.trim() === ""
              }
              disabledReason={t(
                "settings.organization.sso.samlMetadataImportLabel",
              )}
              onClick={() =>
                importMetadataMutation.mutate({
                  source: "url",
                  metadataUrl: metadataUrl.trim(),
                })
              }
              type="button"
              variant="outline"
            >
              {t("settings.organization.sso.samlMetadataImportUrl")}
            </Button>
            <Button
              disabled={importMetadataMutation.isPending}
              disabledReason={t("common.loading")}
              onClick={handleOpenMetadataPicker}
              type="button"
              variant="outline"
            >
              {t("settings.organization.sso.samlMetadataUploadXml")}
            </Button>
          </div>
        </Field>
        <Field>
          <FieldLabel>
            {t("settings.organization.sso.samlEntityIdLabel")}
          </FieldLabel>
          <Input
            onChange={(e) => setIssuer(e.target.value)}
            placeholder="http://www.okta.com/exk..."
            required
            value={issuer}
          />
        </Field>
        <Field>
          <FieldLabel>
            {t("settings.organization.sso.samlEntryPointLabel")}
          </FieldLabel>
          <Input
            onChange={(e) => setEntryPoint(e.target.value)}
            placeholder="https://your-org.okta.com/app/.../sso/saml"
            required
            type="url"
            value={entryPoint}
          />
        </Field>
        <Field>
          <FieldLabel>
            {t("settings.organization.sso.samlCertLabel")}
          </FieldLabel>
          <Textarea
            onChange={(e) => setCert(e.target.value)}
            placeholder="-----BEGIN CERTIFICATE-----"
            required
            rows={4}
            value={cert}
          />
        </Field>
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
          <Button
            disabled={createProviderMutation.isPending}
            disabledReason={t("common.loading")}
            onClick={onCancel}
            type="button"
            variant="ghost"
          >
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
  const queryClient = useQueryClient();
  const [addProtocol, setAddProtocol] = useState<"closed" | "oidc" | "saml">(
    "closed",
  );

  const deleteProviderMutation = useMutation({
    mutationFn: resourceMutation({
      mutation: "removeOrganizationSsoProvider",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (providerId: string) =>
        await removeOrgSsoProvider(providerId),
    }),
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

  const handleProviderCreated = async () => {
    setAddProtocol("closed");
    await onChanged();
  };

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
        {addProtocol === "closed" && (
          <div className="flex gap-1.5">
            <Button
              onClick={() => setAddProtocol("oidc")}
              size="sm"
              type="button"
            >
              {t("settings.organization.sso.addProvider")}
            </Button>
            <Button
              onClick={() => setAddProtocol("saml")}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("settings.organization.sso.addSamlProvider")}
            </Button>
          </div>
        )}
      </div>

      {addProtocol === "oidc" && (
        <AddOidcProviderForm
          onCancel={() => setAddProtocol("closed")}
          onCreated={handleProviderCreated}
        />
      )}
      {addProtocol === "saml" && (
        <AddSamlProviderForm
          onCancel={() => setAddProtocol("closed")}
          onCreated={handleProviderCreated}
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
                {provider.protocol === "oidc" && (
                  <CopyValueRow
                    label={t("settings.organization.sso.callbackUrlLabel")}
                    value={provider.callbackUrl}
                  />
                )}
                {provider.acsUrl !== null && (
                  <CopyValueRow
                    label={t("settings.organization.sso.acsUrlLabel")}
                    value={provider.acsUrl}
                  />
                )}
                {provider.spMetadataUrl !== null && (
                  <CopyValueRow
                    label={t("settings.organization.sso.spMetadataUrlLabel")}
                    value={provider.spMetadataUrl}
                  />
                )}
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
  const queryClient = useQueryClient();
  const [newDomain, setNewDomain] = useState("");

  const createDomainMutation = useMutation({
    mutationFn: resourceMutation({
      mutation: "addOrganizationSsoDomain",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (domain: string) => await addOrgSsoDomain(domain),
    }),
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

  const verifyDomainMutationFn = resourceMutation({
    mutation: "verifyOrganizationSsoDomain",
    queryClient,
    scope: { type: "organization" },
    mutationFn: async (domainId: string) => await verifyOrgSsoDomain(domainId),
  });
  const verifyDomainMutation = useMutation({
    mutationFn: verifyDomainMutationFn,
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
    mutationFn: resourceMutation({
      mutation: "removeOrganizationSsoDomain",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (domainId: string) =>
        await removeOrgSsoDomain(domainId),
    }),
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
                      ? t("common.verified")
                      : t("organization.invitations.statuses.pending")}
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

const PROVISIONING_MODE_KEYS = {
  invite_only: "settings.organization.sso.provisioningModeInviteOnly",
  admin_approval: "settings.organization.sso.provisioningModeAdminApproval",
  jit_active: "settings.organization.sso.provisioningModeJitActive",
} as const satisfies Record<OrganizationSsoProvisioningMode, string>;

const ProvisioningAndSeatsSection = ({
  requirement,
  provisioningMode,
  seatLimit,
  activeSeatCount,
  pendingMembers,
  onChanged,
}: {
  requirement: "optional" | "required";
  provisioningMode: OrganizationSsoProvisioningMode;
  seatLimit: number | null;
  activeSeatCount: number;
  pendingMembers: readonly OrganizationSsoPendingMemberSummary[];
  onChanged: () => Promise<void>;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [selectedMode, setSelectedMode] =
    useState<OrganizationSsoProvisioningMode>(provisioningMode);
  const [seatLimitInput, setSeatLimitInput] = useState(
    seatLimit === null ? "" : String(seatLimit),
  );

  const saveMutation = useMutation({
    mutationFn: resourceMutation({
      mutation: "saveOrganizationSsoPolicy",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (body: UpdateOrganizationSsoPolicyBody) =>
        await saveOrgSsoPolicy(body),
    }),
    onSuccess: async () => {
      await onChanged();
      stellaToast.add({
        title: t("settings.organization.sso.provisioningUpdated"),
        type: "success",
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  const approveMutation = useMutation({
    mutationFn: resourceMutation({
      mutation: "approveOrganizationSsoPendingMember",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (pendingId: string) =>
        await approveOrgSsoPendingMember(pendingId),
    }),
    onSuccess: async () => {
      await onChanged();
      stellaToast.add({
        title: t("settings.organization.sso.pendingApproved"),
        type: "success",
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  const rejectMutation = useMutation({
    mutationFn: resourceMutation({
      mutation: "rejectOrganizationSsoPendingMember",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (pendingId: string) =>
        await rejectOrgSsoPendingMember(pendingId),
    }),
    onSuccess: async () => {
      await onChanged();
      stellaToast.add({
        title: t("settings.organization.sso.pendingRejected"),
        type: "success",
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  const handleSave = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = seatLimitInput.trim();
    let parsedSeatLimit: number | null = null;
    if (trimmed.length > 0) {
      if (!/^[1-9]\d*$/u.test(trimmed)) {
        return;
      }
      const parsed =
        updateOrganizationSsoPolicyBodySchema.shape.seatLimit.safeParse(
          JSON.parse(trimmed),
        );
      if (!parsed.success) {
        return;
      }
      parsedSeatLimit = parsed.data ?? null;
    }
    saveMutation.mutate({
      requirement,
      provisioningMode: selectedMode,
      seatLimit: parsedSeatLimit,
    });
  };

  return (
    <section className="border-border bg-card space-y-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-foreground text-sm font-medium">
            {t("settings.organization.sso.provisioningTitle")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("settings.organization.sso.provisioningDescription")}
          </p>
        </div>
        <span className="bg-muted text-muted-foreground rounded-sm px-2 py-0.5 text-xs font-medium">
          {seatLimit === null
            ? t("settings.organization.sso.seatsUnlimited", {
                count: String(activeSeatCount),
              })
            : t("settings.organization.sso.seatsCount", {
                active: String(activeSeatCount),
                limit: String(seatLimit),
              })}
        </span>
      </div>

      <Form onSubmit={handleSave}>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {ORGANIZATION_SSO_PROVISIONING_MODES.map((mode) => (
              <Button
                key={mode}
                onClick={() => setSelectedMode(mode)}
                size="xs"
                type="button"
                variant={selectedMode === mode ? "default" : "outline"}
              >
                {t(PROVISIONING_MODE_KEYS[mode])}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Field className="min-w-44">
              <FieldLabel>
                {t("settings.organization.sso.seatLimitLabel")}
              </FieldLabel>
              <Input
                dir="ltr"
                inputMode="numeric"
                onChange={(e) => setSeatLimitInput(e.target.value)}
                placeholder={t(
                  "settings.organization.sso.seatLimitPlaceholder",
                )}
                type="text"
                value={seatLimitInput}
              />
            </Field>
            <Button
              disabled={saveMutation.isPending}
              disabledReason={t("common.loading")}
              size="sm"
              type="submit"
            >
              {t("settings.organization.sso.saveProvisioning")}
            </Button>
          </div>
        </div>
      </Form>

      {pendingMembers.length > 0 && (
        <div className="border-border space-y-2 border-t pt-3">
          <h3 className="text-foreground text-xs font-medium">
            {t("settings.organization.sso.pendingApprovalsTitle", {
              count: String(pendingMembers.length),
            })}
          </h3>
          {pendingMembers.map((pending) => (
            <div
              className="border-border flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
              key={pending.id}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-foreground text-sm font-medium">
                    <BidiText>{pending.email}</BidiText>
                  </span>
                  <Badge>
                    {pending.reason === "seat_limit_reached"
                      ? t("settings.organization.sso.pendingReasonSeatLimit")
                      : t("settings.organization.sso.pendingReasonApproval")}
                  </Badge>
                </div>
                {pending.name && (
                  <p className="text-muted-foreground text-xs">
                    <BidiText>{pending.name}</BidiText>
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  disabled={
                    approveMutation.isPending || rejectMutation.isPending
                  }
                  disabledReason={t("common.loading")}
                  onClick={() => approveMutation.mutate(pending.id)}
                  size="xs"
                  type="button"
                >
                  {t("common.approve")}
                </Button>
                <Button
                  disabled={
                    approveMutation.isPending || rejectMutation.isPending
                  }
                  disabledReason={t("common.loading")}
                  onClick={() => rejectMutation.mutate(pending.id)}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  {t("settings.organization.sso.rejectMember")}
                </Button>
              </div>
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

  const settingsQuery = useQuery(
    resourceQueryOptions(
      queryOptions({
        queryKey: SSO_SETTINGS_QUERY_KEY,
        queryFn: async ({ signal }) => await fetchOrgSsoSettings(signal),
      }),
      { type: "independent" },
    ),
  );

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: SSO_SETTINGS_QUERY_KEY });
  };

  const policyMutation = useMutation({
    mutationFn: resourceMutation({
      mutation: "saveOrganizationSsoPolicy",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (body: UpdateOrganizationSsoPolicyBody) =>
        await saveOrgSsoPolicy(body),
    }),
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
              policyMutation.mutate({
                requirement: checked ? "required" : "optional",
                provisioningMode: settings.provisioningMode,
                seatLimit: settings.seatLimit,
              });
            }}
          />
        </div>
      </section>

      <OidcProvidersSection
        onChanged={invalidate}
        providers={settings.providers}
      />
      <ProvisioningAndSeatsSection
        activeSeatCount={settings.activeSeatCount}
        onChanged={invalidate}
        pendingMembers={settings.pendingMembers}
        provisioningMode={settings.provisioningMode}
        requirement={settings.requirement}
        seatLimit={settings.seatLimit}
      />
      <VerifiedDomainsSection
        domains={settings.domains}
        onChanged={invalidate}
      />
    </OrganizationSsoPageShell>
  );
};
