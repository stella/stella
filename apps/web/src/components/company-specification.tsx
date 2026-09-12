import { useId, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import { CopyIcon, Settings2Icon } from "lucide-react";
import { useDebounce } from "use-debounce";
import { useTranslations } from "use-intl";

import { isBusinessRegistryCredentialSlug } from "@stll/api-contract";
import { BUSINESS_REGISTRY_FORMAT_CAPABILITIES } from "@stll/business-registries/default-formats";
import { copyToClipboard } from "@stll/clipboard";
import { Button } from "@stll/ui/button";
import { Field, FieldControl, FieldLabel } from "@stll/ui/field";
import { Skeleton } from "@stll/ui/skeleton";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";

import {
  CompanyFormatLibrary,
  CompanyFormatPicker,
  useCompanyFormatLibrary,
} from "@/components/company-format-library";
import {
  canCopyCompanySpecification,
  COMPANY_SPECIFICATION_FORMAT_MAX_LENGTH,
  companySpecificationQueryKey,
  insertCompanySpecificationToken,
} from "@/components/company-specification.logic";
import { RegistryCredentialSetup } from "@/components/registry-credential-setup";
import { REGISTRY_RETURN_FIELDS } from "@/components/templates/registry-format-config";
import type { LookupRegistryOption } from "@/components/templates/registry-options";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { APIError, unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

const FORMAT_DEBOUNCE_MS = 400;

const CompanySpecificationError = ({
  error,
  registry,
}: {
  error: unknown;
  registry: LookupRegistryOption["slug"];
}) => {
  const t = useTranslations();
  if (
    APIError.is(error) &&
    error.code === "registry_configuration_required" &&
    isBusinessRegistryCredentialSlug(registry)
  ) {
    return <RegistryCredentialSetup registry={registry} source={null} />;
  }
  return (
    <p className="text-destructive text-sm" role="alert">
      {userErrorFromThrown(error, t("common.somethingWentWrong"))}
    </p>
  );
};

type CompanySpecificationProps = {
  registry: LookupRegistryOption["slug"];
  companyId: string;
  initialSettingsVisibility?: "closed" | "open";
};

/** Editable legal-description format backed by the document-template engine. */
export const CompanySpecification = ({
  registry,
  companyId,
  initialSettingsVisibility = "closed",
}: CompanySpecificationProps) => {
  const { activeOrganizationId } = useAuthenticatedUser();
  return (
    <CompanySpecificationEditor
      key={`${activeOrganizationId}:${registry}:${companyId}`}
      companyId={companyId}
      initialSettingsVisibility={initialSettingsVisibility}
      registry={registry}
    />
  );
};

const CompanySpecificationEditor = ({
  registry,
  companyId,
  initialSettingsVisibility = "closed",
}: CompanySpecificationProps) => {
  const t = useTranslations();
  const { activeOrganizationId } = useAuthenticatedUser();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsId = useId();
  const [settingsVisibility, setSettingsVisibility] = useState<
    "open" | "closed"
  >(initialSettingsVisibility);
  const [draftFormat, setFormat] = useState<string | null>(null);
  const library = useCompanyFormatLibrary({
    registry,
    draftFormat,
    onSelect: setFormat,
  });
  const { format } = library;
  const [debouncedFormat] = useDebounce(format, FORMAT_DEBOUNCE_MS);
  const { data, error, isPending } = useQuery({
    enabled: library.saved.isSuccess && format === debouncedFormat,
    queryKey: companySpecificationQueryKey({
      activeOrganizationId,
      registry,
      companyId,
      format: debouncedFormat,
    }),
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api.templates["lookup-preview"].post(
          {
            registry,
            number: companyId,
            format: debouncedFormat.trim() === "" ? null : debouncedFormat,
          },
          { fetch: { signal } },
        ),
      ),
    retry: false,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

  const insertToken = (token: string) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? format.length;
    const end = textarea?.selectionEnd ?? format.length;
    const insertion = insertCompanySpecificationToken({
      format,
      selectionStart: start,
      selectionEnd: end,
      token,
    });
    if (insertion === null) {
      return;
    }
    setFormat(insertion.format);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(insertion.caret, insertion.caret);
    });
  };

  const copySpecification = async () => {
    if (data === undefined) {
      return;
    }
    const copied = await copyToClipboard(data.rendered);
    if (Result.isError(copied)) {
      getAnalytics().captureError(copied.error);
      stellaToast.error(t("errors.actionFailed"));
      return;
    }
    stellaToast.success(t("common.copied"));
  };

  return (
    <section className="flex flex-col gap-3">
      <div id={settingsId} hidden={settingsVisibility === "closed"}>
        <div className="space-y-3 pt-2">
          <CompanyFormatLibrary library={library} />
          <Field>
            <FieldLabel>{t("templates.fieldLookupFormatTemplate")}</FieldLabel>
            <FieldControl
              render={
                <Textarea
                  maxLength={COMPANY_SPECIFICATION_FORMAT_MAX_LENGTH}
                  onChange={(event) => setFormat(event.target.value)}
                  ref={textareaRef}
                  rows={4}
                  value={format}
                />
              }
            />
          </Field>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground text-xs">
              {t("templates.fieldLookupInsertDetail")}
            </span>
            {REGISTRY_RETURN_FIELDS[registry].map((token) => (
              <Button
                className="h-auto min-h-11 px-2 py-1 text-xs"
                key={token}
                onClick={() => insertToken(token)}
                size="sm"
                type="button"
                variant="secondary"
              >
                [{token}]
              </Button>
            ))}
          </div>
        </div>
      </div>
      <div className="bg-muted/40 rounded-lg p-3 shadow-sm">
        {isPending && !library.saved.isError ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : null}
        {library.saved.error && (
          <div className="space-y-2" role="alert">
            <p className="text-destructive text-sm">
              {userErrorFromThrown(
                library.saved.error,
                t("common.somethingWentWrong"),
              )}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                detached(library.saved.refetch(), "company-formats.retry")
              }
            >
              {t("common.retry")}
            </Button>
          </div>
        )}
        {error ? (
          <CompanySpecificationError error={error} registry={registry} />
        ) : null}
        {data ? (
          <p className="text-sm leading-6 whitespace-pre-wrap" dir="auto">
            {data.rendered}
          </p>
        ) : null}
        <div className="mt-1 flex items-center justify-end gap-1">
          <CompanyFormatPicker library={library} />
          <Button
            aria-label={t("templates.fieldLookupFormats")}
            title={t("templates.fieldLookupFormats")}
            aria-controls={settingsId}
            aria-expanded={settingsVisibility === "open"}
            className="size-11"
            size="icon"
            variant="ghost"
            onClick={() =>
              setSettingsVisibility(
                settingsVisibility === "open" ? "closed" : "open",
              )
            }
          >
            <Settings2Icon className="size-4" />
          </Button>
        </div>
      </div>

      <Button
        className="w-full"
        disabled={
          !canCopyCompanySpecification({
            rendered: data?.rendered,
            isPending,
            format,
            debouncedFormat,
          })
        }
        onClick={() =>
          detached(copySpecification(), "company-specification.copy")
        }
        type="button"
      >
        <CopyIcon />
        {t(
          BUSINESS_REGISTRY_FORMAT_CAPABILITIES[registry].type ===
            "company-specification"
            ? "templates.copyCompanySpecification"
            : "templates.copyRegistryResult",
        )}
      </Button>
    </section>
  );
};
