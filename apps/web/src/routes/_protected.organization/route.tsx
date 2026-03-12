import { useEffect, useState } from "react";

import { usePostHog } from "@posthog/react";
import { useForm, useStore } from "@tanstack/react-form";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { produce } from "immer";
import { SearchIcon, SettingsIcon, UserPlusIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stella/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stella/ui/components/dialog";
import { Field, FieldError, FieldLabel } from "@stella/ui/components/field";
import { Form } from "@stella/ui/components/form";
import { Input } from "@stella/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stella/ui/components/input-group";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";
import { toastManager } from "@stella/ui/components/toast";

import { api } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { toAPIError, toAuthClientError } from "@/lib/errors";
import { pageTitle } from "@/lib/page-title";
import { captureError } from "@/lib/posthog/utils";
import { toFormErrors } from "@/lib/schema";
import { roleOptions } from "@/routes/-queries";
import {
  getRoles,
  managementRoles,
  rolePriority,
} from "@/routes/_protected.organization/-consts";
import {
  organizationKeys,
  organizationOptions,
} from "@/routes/_protected.organization/-queries";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/routes/_protected.organization/-settings-queries";
import {
  createSlug,
  getOrganizationSchema,
} from "@/routes/_protected.organization/-utils";

const searchSchema = v.object({
  q: v.optional(v.string()),
});

export const Route = createFileRoute("/_protected/organization")({
  head: () => ({
    meta: [{ title: pageTitle("navigation.organization") }],
  }),
  beforeLoad: async ({ context }) => {
    const role = await context.queryClient.ensureQueryData(roleOptions);

    if (!managementRoles.includes(role)) {
      throw redirect({ to: "/workspaces", replace: true });
    }
  },
  validateSearch: searchSchema,
  component: MembersLayout,
});

function MembersLayout() {
  const t = useTranslations();
  const { q } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [localQuery, setLocalQuery] = useState(() => q ?? "");

  const updateSearch = useDebouncedCallback((value: string) => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    navigate({
      search: (prev) =>
        produce(prev, (draft) => {
          draft.q = value || undefined;
        }),
    });
  }, 300);

  return (
    <div className="flex flex-1 flex-col gap-4 border-t p-4">
      <div className="flex items-center gap-2">
        <InputGroup className="me-auto max-w-sm flex-1">
          <InputGroupInput
            onChange={(e) => {
              const val = e.target.value;
              setLocalQuery(val);
              updateSearch(val);
            }}
            placeholder={t("common.search")}
            value={localQuery}
          />
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
        </InputGroup>
        <SettingsDialog />
        <InviteDialog />
      </div>
      <MatterNumberingSection />
      <Outlet />
    </div>
  );
}

const SettingsDialog = () => {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(false);
  const posthog = usePostHog();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(organizationOptions);

  const form = useForm({
    defaultValues: {
      name: data.name,
      slug: data.slug,
    },
    validators: { onDynamic: getOrganizationSchema() },
    onSubmit: async ({ value, formApi }) => {
      if (value.slug !== data.slug) {
        const { data: slugCheckData, error: slugCheckError } =
          await authClient.organization.checkSlug({
            slug: value.slug,
          });

        if (slugCheckError) {
          captureError(posthog, toAuthClientError(slugCheckError));
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
        data: { name: value.name, slug: value.slug },
      });

      if (result.error) {
        captureError(posthog, toAuthClientError(result.error));
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
      setIsOpen(false);
    },
  });

  const formErrors = useStore(form.store, (s) => toFormErrors(s.fieldMeta));

  return (
    <Dialog
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) {
          form.reset();
        }
      }}
      open={isOpen}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <SettingsIcon />
        {t("common.settings")}
      </DialogTrigger>
      <DialogPopup>
        <Form
          className="gap-0"
          errors={formErrors}
          onSubmit={(e) => {
            e.preventDefault();
            // eslint-disable-next-line typescript/no-floating-promises
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("organization.settings")}</DialogTitle>
            <DialogDescription>
              {t("organization.settingsDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <form.Field name="name">
              {(field) => (
                <Field name={field.name}>
                  <FieldLabel>{t("auth.organizationNameLabel")}</FieldLabel>
                  <Input
                    autoFocus
                    onBlur={field.handleBlur}
                    onChange={(e) => {
                      const val = e.target.value;
                      field.handleChange(val);
                      form.setFieldValue("slug", createSlug(val));
                    }}
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
                  <FieldLabel>{t("auth.slugLabel")}</FieldLabel>
                  <Input
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={t("auth.slugPlaceholder")}
                    required
                    value={field.state.value}
                  />
                  <FieldError />
                </Field>
              )}
            </form.Field>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </DialogClose>
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button loading={isSubmitting} type="submit">
                  {t("common.saveChanges")}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
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

const MatterNumberingSection = () => {
  const t = useTranslations();
  const posthog = usePostHog();
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

  // Sync state when settings load
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

  // Fetch preview when pattern or padding changes
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
      captureError(posthog, error);
      toastManager.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });

  const selectedPreset =
    PATTERN_PRESETS.find((p) => p.value === pattern)?.value ?? "custom";

  return (
    <div className="bg-card flex flex-col gap-3 rounded-xl border p-4">
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
            items={[
              ...PATTERN_PRESETS.map((p) => ({
                value: p.value,
                label: t(`organization.matterNumber.presets.${p.key}`),
              })),
              {
                value: "custom",
                label: t("organization.matterNumber.presets.custom"),
              },
            ]}
            onValueChange={(val) => {
              if (!val) {
                return;
              }
              if (val === "custom") {
                setIsCustom(true);
              } else {
                setIsCustom(false);
                setPattern(val);
              }
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
            items={PADDING_OPTIONS.map((p) => ({
              value: String(p),
              label: String(p),
            }))}
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
    </div>
  );
};

const inviteSchema = v.object({
  email: v.pipe(v.string(), v.email()),
  role: v.picklist(["owner", "admin", "member"]),
});

const defaultValues: v.InferInput<typeof inviteSchema> = {
  email: "",
  role: "member",
};

const InviteDialog = () => {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(false);
  const posthog = usePostHog();
  const queryClient = useQueryClient();
  const { data: currentUserRole } = useSuspenseQuery(roleOptions);

  const roles = getRoles(t);

  const form = useForm({
    defaultValues,
    validators: { onDynamic: inviteSchema },
    onSubmit: async ({ value }) => {
      const result = await authClient.organization.inviteMember({
        email: value.email,
        role: value.role,
      });

      if (result.error) {
        captureError(posthog, toAuthClientError(result.error));
        toastManager.add({
          title: result.error.message ?? t("errors.actionFailed"),
          type: "error",
        });
        return;
      }

      await queryClient.invalidateQueries({ queryKey: organizationKeys.all });
      toastManager.add({ title: t("success.invitationSent"), type: "success" });
      setIsOpen(false);
    },
  });

  const formErrors = useStore(form.store, (s) => toFormErrors(s.fieldMeta));

  return (
    <Dialog
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) {
          form.reset();
        }
      }}
      open={isOpen}
    >
      <DialogTrigger
        onClick={() => setIsOpen(true)}
        render={<Button size="sm" />}
      >
        <UserPlusIcon />
        {t("common.invite")}
      </DialogTrigger>
      <DialogPopup>
        <Form
          className="gap-0"
          errors={formErrors}
          onSubmit={(e) => {
            e.preventDefault();
            // eslint-disable-next-line typescript/no-floating-promises
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t("organization.invitations.inviteMember")}
            </DialogTitle>
            <DialogDescription>
              {t("organization.invitations.inviteMemberDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <form.Field name="email">
              {(field) => (
                <Field name={field.name}>
                  <FieldLabel>
                    {t("organization.invitations.emailAddressLabel")}
                  </FieldLabel>
                  <Input
                    autoFocus
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={t(
                      "organization.invitations.emailAddressPlaceholder",
                    )}
                    required
                    type="email"
                    value={field.state.value}
                  />
                  <FieldError />
                </Field>
              )}
            </form.Field>
            <form.Field name="role">
              {(field) => (
                <Field name={field.name}>
                  <FieldLabel>{t("common.role")}</FieldLabel>
                  <Select
                    items={roles}
                    onValueChange={(val) => {
                      if (val) {
                        field.handleChange(val);
                      }
                    }}
                    value={field.state.value}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t("common.selectARole")} />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {roles.map((item) => (
                        <SelectItem
                          disabled={
                            rolePriority[item.value] <
                            rolePriority[currentUserRole]
                          }
                          key={item.value}
                          value={item.value}
                        >
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <FieldError />
                </Field>
              )}
            </form.Field>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </DialogClose>
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button loading={isSubmitting} type="submit">
                  {t("organization.invitations.sendInvitation")}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
};
