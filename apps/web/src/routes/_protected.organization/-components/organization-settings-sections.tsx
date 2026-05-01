import { useEffect, useState } from "react";

import { Button } from "@stll/ui/components/button";
import { Field, FieldError, FieldLabel } from "@stll/ui/components/field";
import { Form } from "@stll/ui/components/form";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { toastManager } from "@stll/ui/components/toast";
import { useForm, useStore } from "@tanstack/react-form";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { toAPIError, toAuthClientError } from "@/lib/errors";
import { toFormErrors } from "@/lib/schema";
import {
  organizationKeys,
  organizationOptions,
} from "@/routes/_protected.organization/-queries";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/routes/_protected.organization/-settings-queries";
import { getOrganizationSchema } from "@/routes/_protected.organization/-utils";

export const OrganizationProfileSection = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(organizationOptions);

  const form = useForm({
    defaultValues: {
      name: data.name,
      slug: data.slug,
    },
    validators: { onDynamic: getOrganizationSchema() },
    onSubmit: async ({ value, formApi }) => {
      const parseResult = v.safeParse(getOrganizationSchema(), value);
      if (!parseResult.success) {
        return;
      }

      const parsedValue = parseResult.output;
      if (parsedValue.slug !== data.slug) {
        const { data: slugCheckData, error: slugCheckError } =
          await authClient.organization.checkSlug({
            slug: parsedValue.slug,
          });

        if (slugCheckError) {
          analytics.captureError(toAuthClientError(slugCheckError));
          toastManager.add({
            title: slugCheckError.message ?? t("errors.actionFailed"),
            type: "error",
          });
          return;
        }

        if (!slugCheckData?.status) {
          formApi.setErrorMap({
            onSubmit: { fields: { slug: t("errors.slugAlreadyTaken") } },
          });
          return;
        }
      }

      const result = await authClient.organization.update({
        data: { name: parsedValue.name, slug: parsedValue.slug },
      });

      if (result.error) {
        analytics.captureError(toAuthClientError(result.error));
        toastManager.add({
          title: result.error.message ?? t("errors.actionFailed"),
          type: "error",
        });
        return;
      }

      await queryClient.invalidateQueries({ queryKey: organizationKeys.all });
      toastManager.add({
        title: t("success.organizationUpdated"),
        type: "success",
      });
    },
  });

  const formErrors = useStore(form.store, (s) => toFormErrors(s.fieldMeta));

  return (
    <section className="bg-card flex flex-col gap-4 rounded-lg border p-4">
      <div>
        <h3 className="text-sm font-medium">{t("organization.settings")}</h3>
        <p className="text-muted-foreground text-xs">
          {t("organization.settingsDescription")}
        </p>
      </div>
      <Form
        className="gap-4"
        errors={formErrors}
        onSubmit={(e) => {
          e.preventDefault();
          // eslint-disable-next-line typescript/no-floating-promises
          form.handleSubmit();
        }}
      >
        <form.Field name="name">
          {(field) => (
            <Field name={field.name}>
              <FieldLabel>{t("common.organizationName")}</FieldLabel>
              <Input
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder={t("auth.organizationNamePlaceholder")}
                required
                value={field.state.value}
              />
              <FieldError />
            </Field>
          )}
        </form.Field>
        <form.Field name="slug">
          {(field) => (
            <Field name={field.name}>
              <FieldLabel>{t("common.urlIdentifier")}</FieldLabel>
              <Input
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder={t("common.urlIdentifierPlaceholder")}
                required
                value={field.state.value}
              />
              <FieldError />
            </Field>
          )}
        </form.Field>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button className="self-start" loading={isSubmitting} type="submit">
              {t("common.saveChanges")}
            </Button>
          )}
        </form.Subscribe>
      </Form>
    </section>
  );
};

const PATTERN_PRESETS = [
  { value: "{SEQ}", key: "sequential" as const },
  { value: "{YYYY}/{SEQ}", key: "yearSequential" as const },
  {
    value: "{YYYY}-{MM}/{SEQ}",
    key: "yearMonthSequential" as const,
  },
] as const;

const PADDING_OPTIONS = [2, 3, 4, 5, 6] as const;

export const MatterNumberingSection = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(organizationSettingsOptions);

  const [pattern, setPattern] = useState(
    settings?.matterNumberPattern ?? "{SEQ}",
  );
  const [padding, setPadding] = useState(settings?.matterNumberPadding ?? 3);
  const [isCustom, setIsCustom] = useState(() => {
    const p = settings?.matterNumberPattern ?? "{SEQ}";
    return !PATTERN_PRESETS.some((preset) => preset.value === p);
  });
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) {
      return;
    }

    setPattern(settings.matterNumberPattern);
    setPadding(settings.matterNumberPadding);
    setIsCustom(
      !PATTERN_PRESETS.some(
        (preset) => preset.value === settings.matterNumberPattern,
      ),
    );
  }, [settings]);

  const fetchPreview = useDebouncedCallback(async (p: string, pad: number) => {
    const response = await api["organization-settings"].preview.post({
      matterNumberPattern: p,
      matterNumberPadding: pad,
    });
    if (!response.error) {
      setPreview(response.data.preview);
    }
  }, 300);

  useEffect(() => {
    // eslint-disable-next-line typescript/no-floating-promises
    fetchPreview(pattern, padding);
  }, [pattern, padding, fetchPreview]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      const response = await api["organization-settings"].post({
        matterNumberPattern: pattern,
        matterNumberPadding: padding,
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: organizationSettingsKeys.all,
      });
      toastManager.add({
        title: t("success.matterNumberingUpdated"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      toastManager.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });

  const selectedPreset =
    PATTERN_PRESETS.find((p) => p.value === pattern)?.value ?? "custom";

  return (
    <section className="bg-card flex flex-col gap-3 rounded-lg border p-4">
      <div>
        <h3 className="text-sm font-medium">
          {t("organization.matterNumber.title")}
        </h3>
        <p className="text-muted-foreground text-xs">
          {t("organization.matterNumber.description")}
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Field>
          <FieldLabel>{t("organization.matterNumber.pattern")}</FieldLabel>
          <Select
            onValueChange={(val) => {
              if (!val) {
                return;
              }

              if (val === "custom") {
                setIsCustom(true);
                return;
              }

              setIsCustom(false);
              setPattern(val);
            }}
            value={selectedPreset}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {[
                ...PATTERN_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {t(`organization.matterNumber.presets.${p.key}`)}
                  </SelectItem>
                )),
                <SelectItem key="custom" value="custom">
                  {t("organization.matterNumber.presets.custom")}
                </SelectItem>,
              ]}
            </SelectPopup>
          </Select>
        </Field>
        {isCustom && (
          <Field>
            <Input
              onChange={(e) => setPattern(e.target.value)}
              placeholder="{YYYY}/{SEQ}"
              value={pattern}
            />
            <p className="text-muted-foreground text-xs">
              {t("organization.matterNumber.tokenHelp")}
            </p>
          </Field>
        )}
        <Field>
          <FieldLabel>{t("organization.matterNumber.padding")}</FieldLabel>
          <Select
            onValueChange={(val) => {
              if (val) {
                setPadding(Number(val));
              }
            }}
            value={String(padding)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {PADDING_OPTIONS.map((p) => (
                <SelectItem key={p} value={String(p)}>
                  {p}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <p className="text-muted-foreground text-xs">
            {t("organization.matterNumber.paddingDescription")}
          </p>
        </Field>
        {preview && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {t("organization.matterNumber.nextPreview")}
            </span>
            <span className="bg-muted rounded border px-2 py-1 font-mono text-sm">
              {preview}
            </span>
          </div>
        )}
        <Button
          className="self-start"
          loading={updateMutation.isPending}
          onClick={() => updateMutation.mutate()}
          size="sm"
        >
          {t("common.saveChanges")}
        </Button>
      </div>
    </section>
  );
};
