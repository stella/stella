import { useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { DestructiveConfirmDialog } from "@stll/ui/components/destructive-confirm-dialog";
import { Field, FieldDescription, FieldLabel } from "@stll/ui/components/field";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Textarea } from "@stll/ui/components/textarea";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";
import {
  ssoConnectionKeys,
  ssoConnectionOptions,
} from "@/routes/_protected.settings/-queries/sso";
import type { SsoConnection } from "@/routes/_protected.settings/-queries/sso";

type SsoProtocol = "oidc" | "saml";

type CreateSsoInput =
  | {
      protocol: "oidc";
      domain: string;
      issuer: string;
      clientId: string;
      clientSecret: string;
    }
  | {
      protocol: "saml";
      domain: string;
      issuer: string;
      entryPoint: string;
      certificate: string;
    };

export const SsoCard = ({ organizationId }: { organizationId: string }) => {
  const { data } = useSuspenseQuery(ssoConnectionOptions({ organizationId }));

  if (data.connection) {
    return (
      <ConfiguredSsoCard
        connection={data.connection}
        organizationId={organizationId}
      />
    );
  }

  return <CreateSsoCard organizationId={organizationId} />;
};

const CreateSsoCard = ({ organizationId }: { organizationId: string }) => {
  const t = useTranslations();
  const [protocol, setProtocol] = useState<SsoProtocol>("oidc");
  const [domain, setDomain] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [entryPoint, setEntryPoint] = useState("");
  const [certificate, setCertificate] = useState("");
  const queryKey = ssoConnectionKeys.byOrganization({ organizationId });

  const createMutation = useSettingsMutation<CreateSsoInput, SsoConnection>({
    mutationFn: async (input) =>
      unwrapEden(await api["sso-connections"].post(input)),
    invalidate: queryKey,
    successToast: { title: t("settings.organization.sso.created") },
    errorToast: {
      title: t("settings.organization.sso.createFailed"),
      description: t("errors.actionFailed"),
    },
  });

  const canSubmit =
    domain.trim().length > 0 &&
    issuer.trim().length > 0 &&
    (protocol === "oidc"
      ? clientId.trim().length > 0 && clientSecret.length > 0
      : entryPoint.trim().length > 0 && certificate.trim().length > 0);

  const handleSubmit = () => {
    if (!canSubmit) {
      return;
    }
    if (protocol === "oidc") {
      createMutation.mutate({
        protocol: "oidc",
        domain,
        issuer,
        clientId,
        clientSecret,
      });
      return;
    }
    createMutation.mutate({
      protocol: "saml",
      domain,
      issuer,
      entryPoint,
      certificate,
    });
  };

  return (
    <Frame>
      <FramePanel>
        <form
          className="flex flex-col gap-4 p-1"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <Field>
            <FieldLabel>{t("settings.organization.sso.protocol")}</FieldLabel>
            <Select
              onValueChange={(value) => setProtocol(value ?? "oidc")}
              value={protocol}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {/* eslint-disable-next-line no-untranslated-jsx-literal/no-untranslated-jsx-literal -- Standard protocol name */}
                <SelectItem value="oidc">OIDC</SelectItem>
                {/* eslint-disable-next-line no-untranslated-jsx-literal/no-untranslated-jsx-literal -- Standard protocol name */}
                <SelectItem value="saml">SAML 2.0</SelectItem>
              </SelectPopup>
            </Select>
          </Field>
          <Field>
            <FieldLabel>{t("settings.organization.sso.domain")}</FieldLabel>
            <Input
              autoComplete="off"
              onChange={(event) => setDomain(event.target.value)}
              placeholder="example.com"
              required
              value={domain}
            />
            <FieldDescription>
              {t("settings.organization.sso.domainDescription")}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>
              {protocol === "oidc"
                ? t("settings.organization.sso.oidcIssuer")
                : t("settings.organization.sso.samlEntityId")}
            </FieldLabel>
            <Input
              autoComplete="off"
              onChange={(event) => setIssuer(event.target.value)}
              required
              value={issuer}
            />
          </Field>
          {protocol === "oidc" ? (
            <>
              <Field>
                <FieldLabel>
                  {t("settings.organization.sso.clientId")}
                </FieldLabel>
                <Input
                  autoComplete="off"
                  onChange={(event) => setClientId(event.target.value)}
                  required
                  value={clientId}
                />
              </Field>
              <Field>
                <FieldLabel>
                  {t("settings.organization.sso.clientSecret")}
                </FieldLabel>
                <Input
                  autoComplete="new-password"
                  onChange={(event) => setClientSecret(event.target.value)}
                  required
                  type="password"
                  value={clientSecret}
                />
              </Field>
            </>
          ) : (
            <>
              <Field>
                <FieldLabel>
                  {t("settings.organization.sso.samlSignInUrl")}
                </FieldLabel>
                <Input
                  autoComplete="off"
                  onChange={(event) => setEntryPoint(event.target.value)}
                  required
                  type="url"
                  value={entryPoint}
                />
              </Field>
              <Field>
                <FieldLabel>
                  {t("settings.organization.sso.samlCertificate")}
                </FieldLabel>
                <Textarea
                  className="font-mono"
                  onChange={(event) => setCertificate(event.target.value)}
                  required
                  value={certificate}
                />
              </Field>
            </>
          )}
          <Button
            className="self-start"
            disabled={!canSubmit}
            loading={createMutation.isPending}
            type="submit"
          >
            {t("settings.organization.sso.configure")}
          </Button>
        </form>
      </FramePanel>
    </Frame>
  );
};

const ConfiguredSsoCard = ({
  organizationId,
  connection,
}: {
  organizationId: string;
  connection: SsoConnection;
}) => {
  const t = useTranslations();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const queryKey = ssoConnectionKeys.byOrganization({ organizationId });
  const mutationOptions = {
    invalidate: queryKey,
    errorToast: {
      title: t("settings.organization.sso.updateFailed"),
      description: t("errors.actionFailed"),
    },
  };
  const requestVerification = useSettingsMutation({
    ...mutationOptions,
    mutationFn: async () =>
      unwrapEden(await api["sso-connections"]["domain-verification"].post()),
  });
  const verifyDomain = useSettingsMutation({
    ...mutationOptions,
    mutationFn: async () =>
      unwrapEden(await api["sso-connections"]["verify-domain"].post()),
    successToast: { title: t("settings.organization.sso.domainVerified") },
  });
  const setEnforcement = useSettingsMutation<"optional" | "required">({
    ...mutationOptions,
    mutationFn: async (mode) =>
      unwrapEden(await api["sso-connections"].enforcement.post({ mode })),
    successToast: { title: t("settings.organization.sso.enforcementUpdated") },
  });
  const deleteConnection = useSettingsMutation({
    ...mutationOptions,
    mutationFn: async () => unwrapEden(await api["sso-connections"].delete()),
    successToast: { title: t("settings.organization.sso.deleted") },
    onSuccess: () => setDeleteOpen(false),
  });

  const isPending =
    requestVerification.isPending ||
    verifyDomain.isPending ||
    setEnforcement.isPending ||
    deleteConnection.isPending;

  return (
    <>
      <Frame>
        <FramePanel>
          <div className="flex flex-col gap-5 p-1">
            <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted-foreground">
                {t("settings.organization.sso.protocol")}
              </dt>
              <dd>{connection.protocol.toUpperCase()}</dd>
              <dt className="text-muted-foreground">
                {t("settings.organization.sso.domain")}
              </dt>
              <dd dir="ltr">{connection.domain}</dd>
              <dt className="text-muted-foreground">{t("common.status")}</dt>
              <dd>
                {connection.domainVerified
                  ? t("settings.organization.sso.domainVerified")
                  : t("settings.organization.sso.domainPending")}
              </dd>
              <dt className="text-muted-foreground">
                {t("settings.organization.sso.enforcement")}
              </dt>
              <dd>
                {connection.enforcementMode === "required"
                  ? t("common.required")
                  : t("settings.organization.sso.optional")}
              </dd>
              <dt className="text-muted-foreground">
                {t("settings.organization.sso.callbackUrl")}
              </dt>
              <dd className="font-mono text-xs break-all" dir="ltr">
                {connection.callbackUrl}
              </dd>
              {connection.metadataUrl && (
                <>
                  <dt className="text-muted-foreground">
                    {t("settings.organization.sso.metadataUrl")}
                  </dt>
                  <dd className="font-mono text-xs break-all" dir="ltr">
                    {connection.metadataUrl}
                  </dd>
                </>
              )}
            </dl>

            {!connection.domainVerified && (
              <div className="flex flex-col gap-3 border-t pt-5">
                <p className="text-sm">
                  {t("settings.organization.sso.dnsDescription")}
                </p>
                {connection.dnsVerification && (
                  <dl className="grid gap-2 text-sm sm:grid-cols-[5rem_1fr]">
                    <dt className="text-muted-foreground">
                      {t("settings.organization.sso.dnsName")}
                    </dt>
                    <dd className="font-mono text-xs break-all" dir="ltr">
                      {connection.dnsVerification.name}
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("settings.organization.sso.dnsValue")}
                    </dt>
                    <dd className="font-mono text-xs break-all" dir="ltr">
                      {connection.dnsVerification.value}
                    </dd>
                  </dl>
                )}
                <div className="flex flex-wrap gap-2">
                  {!connection.dnsVerification && (
                    <Button
                      disabled={isPending}
                      onClick={() => requestVerification.mutate()}
                      size="sm"
                      variant="outline"
                    >
                      {t("settings.organization.sso.requestDnsRecord")}
                    </Button>
                  )}
                  {connection.dnsVerification && (
                    <Button
                      disabled={isPending}
                      onClick={() => verifyDomain.mutate()}
                      size="sm"
                    >
                      {t("settings.organization.sso.verifyDomain")}
                    </Button>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t pt-5">
              <Button
                disabled={
                  isPending ||
                  !connection.domainVerified ||
                  connection.enforcementMode === "required"
                }
                onClick={() => setEnforcement.mutate("required")}
                size="sm"
              >
                {t("settings.organization.sso.requireSso")}
              </Button>
              <Button
                disabled={
                  isPending || connection.enforcementMode === "optional"
                }
                onClick={() => setEnforcement.mutate("optional")}
                size="sm"
                variant="outline"
              >
                {t("settings.organization.sso.makeOptional")}
              </Button>
              <Button
                className="sm:ms-auto"
                disabled={
                  isPending || connection.enforcementMode === "required"
                }
                onClick={() => setDeleteOpen(true)}
                size="sm"
                variant="destructive"
              >
                {t("common.delete")}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              {t("settings.organization.sso.requireDescription")}
            </p>
          </div>
        </FramePanel>
      </Frame>
      <DestructiveConfirmDialog
        cancelLabel={t("common.cancel")}
        confirmation={connection.domain}
        confirmLabel={t("common.delete")}
        description={t("settings.organization.sso.deleteDescription")}
        inputLabel={t("settings.organization.sso.deleteConfirmation", {
          domain: connection.domain,
        })}
        onConfirm={async () => {
          await deleteConnection.mutateAsync();
        }}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title={t("settings.organization.sso.deleteTitle")}
      />
    </>
  );
};
