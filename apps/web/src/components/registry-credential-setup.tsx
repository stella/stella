import { useId, useState } from "react";
import type { ChangeEvent } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BUSINESS_REGISTRY_CONFIGURATION } from "@stll/api-contract";
import type { BusinessRegistryCredentialSlug } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { stellaToast } from "@stll/ui/toast";

import { companySpecificationRegistryKey } from "@/components/company-specification.logic";
import { SecretInput } from "@/components/secret-input";
import { businessRegistryConfigurationKeys } from "@/components/templates/registry-configuration-queries";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { contactsKeys } from "@/lib/contacts/queries";
import { unwrapEden } from "@/lib/errors/api";

type RegistryCredentialSetupProps = {
  registry: BusinessRegistryCredentialSlug;
  source: "public" | "deployment" | "organization" | null;
};

export const RegistryCredentialSetup = ({
  registry,
  source,
}: RegistryCredentialSetupProps) => {
  const t = useTranslations();
  const inputId = useId();
  const hintId = useId();
  const { activeOrganizationId } = useAuthenticatedUser();
  const canConfigure = usePermissions({ organizationSettings: ["update"] });
  const queryClient = useQueryClient();
  const [credential, setCredential] = useState("");
  const configuration = BUSINESS_REGISTRY_CONFIGURATION[registry];
  const refresh = async () => {
    setCredential("");
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey:
          businessRegistryConfigurationKeys.scoped(activeOrganizationId),
      }),
      queryClient.invalidateQueries({
        queryKey: contactsKeys.scoped(activeOrganizationId),
      }),
      queryClient.invalidateQueries({
        queryKey: companySpecificationRegistryKey({
          activeOrganizationId,
          registry,
        }),
      }),
    ]);
  };
  const save = useMutation({
    // The secret never enters the mutation variables/cache or a query key.
    mutationFn: async () =>
      unwrapEden(
        await api["organization-settings"][
          "business-registry-credentials"
        ].post({
          registry,
          credential: credential.trim(),
        }),
      ),
    onSuccess: async () => {
      stellaToast.success(t("search.registryCredentialSaved"));
      await refresh();
    },
    onError: () => stellaToast.error(t("common.somethingWentWrong")),
    onSettled: () => {
      save.reset();
    },
    gcTime: 0,
  });
  const remove = useMutation({
    mutationFn: async () =>
      unwrapEden(
        await api["organization-settings"][
          "business-registry-credentials"
        ].delete(
          {},
          {
            query: { registry },
          },
        ),
      ),
    onSuccess: refresh,
    onError: () => stellaToast.error(t("common.somethingWentWrong")),
  });

  if (!canConfigure) {
    return (
      <p className="text-muted-foreground px-3 py-2 text-sm">
        {t("search.registryCredentialAskAdmin")}
      </p>
    );
  }

  const pending = save.isPending || remove.isPending;
  const inputProps = {
    id: inputId,
    "aria-describedby": hintId,
    value: credential,
    onChange: (event: ChangeEvent<HTMLInputElement>) =>
      setCredential(event.target.value),
    autoComplete: "off",
    spellCheck: false,
    maxLength: 2000,
    disabled: pending,
    className: "min-h-11",
  };

  return (
    <div className="space-y-3 px-3 py-2">
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor={inputId}>
          {t(
            configuration === "api-key"
              ? "catalogue.setup.apiKey"
              : "search.registryCredentialUserAgent",
          )}
        </label>
        {configuration === "api-key" ? (
          <SecretInput {...inputProps} />
        ) : (
          <Input {...inputProps} />
        )}
        <p className="text-muted-foreground text-xs" id={hintId}>
          {t(
            configuration === "user-agent"
              ? "search.registryCredentialUserAgentHint"
              : "search.registryCredentialSharedHint",
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          className="min-h-11"
          disabled={pending || credential.trim() === ""}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {t("common.save")}
        </Button>
        {source === "organization" ? (
          <Button
            className="min-h-11"
            variant="ghost"
            disabled={pending}
            loading={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {t("common.remove")}
          </Button>
        ) : null}
      </div>
    </div>
  );
};
