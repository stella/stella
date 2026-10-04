import { useId } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "use-intl";

import { Temporal, todayFor } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Field, FieldLabel } from "@stll/ui/field";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { Switch } from "@/components/switch";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { schemaFormOptions } from "@/lib/schema";
import { myTimeEntriesKeys } from "@/lib/workspaces/queries/my-time-entries";
import { timeEntriesKeys } from "@/lib/workspaces/queries/time-entries";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/queries/organization-settings";
import { MonthLockPicker } from "@/routes/_protected.settings/-components/organization/month-lock-picker";
import {
  TIME_UNIT_OPTIONS,
  timePolicyErrorKey,
  timePolicyFormSchema,
  timePolicyPatch,
  type TimePolicy,
  type TimePolicySettings,
} from "@/routes/_protected.settings/-components/organization/time-policy.logic";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";

export const TimePolicyCard = () => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const query = useQuery(
    organizationSettingsOptions({
      organizationId: user.activeOrganizationId,
      userId: user.id,
    }),
  );
  const canEdit = usePermissions({ organizationSettings: ["update"] });
  if (query.error !== null) {
    return (
      <div className="flex items-center gap-2">
        <p className="text-destructive text-sm" role="alert">
          {query.error.message}
        </p>
        <Button
          onClick={() => detached(query.refetch(), "time-policy.retry")}
          variant="ghost"
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  if (!query.data) {
    return (
      <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
    );
  }
  return (
    <TimePolicyForm
      key={`${user.activeOrganizationId}:${String(query.data.timeMinimumUnitMinutes)}:${String(query.data.timeEditWindowDays)}:${String(query.data.timeLockedThroughMonth)}:${String(query.data.timeNarrativeRequired)}:${query.data.timeZone}`}
      settings={query.data}
      canEdit={canEdit}
    />
  );
};

type TimePolicyFormProps = { settings: TimePolicySettings; canEdit: boolean };
export const TimePolicyForm = ({ settings, canEdit }: TimePolicyFormProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const id = useId();
  const user = useAuthenticatedUser();
  const queryClient = useQueryClient();
  // The server judges a lock month on the organization's day; so do the
  // picker and the form, at one instant.
  const at = Temporal.Now.instant();
  const today = todayFor(settings.timeZone, at);
  const mutation = useSettingsMutation({
    mutationFn: async (next: TimePolicy) =>
      unwrapEden(
        await api["organization-settings"].post(
          timePolicyPatch({ original: settings, next }),
        ),
      ),
    invalidate: organizationSettingsKeys.byOrganization(
      user.activeOrganizationId,
    ),
    onSuccess: () => {
      detached(
        Promise.all([
          queryClient.invalidateQueries({ queryKey: timeEntriesKeys.root() }),
          queryClient.invalidateQueries({
            queryKey: myTimeEntriesKeys.all(user.activeOrganizationId),
          }),
        ]),
        "time-policy.invalidate-entries",
      );
    },
  });
  const form = useForm(
    schemaFormOptions({
      defaultValues: {
        timeMinimumUnitMinutes: settings.timeMinimumUnitMinutes,
        timeEditWindowDays: String(settings.timeEditWindowDays),
        timeLockedThroughMonth:
          settings.timeLockedThroughMonth?.slice(0, 7) ?? "",
        timeNarrativeRequired: settings.timeNarrativeRequired,
      },
      schema: timePolicyFormSchema({
        timeZone: settings.timeZone,
        at,
        messages: {
          minimumUnit: t("settings.organization.timePolicy.invalidMinimumUnit"),
          editWindow: t("settings.organization.timePolicy.invalidEditWindow"),
          lockedMonth: t("settings.organization.timePolicy.invalidLockedMonth"),
        },
      }),
      submitValues: "schema-output",
      onSubmit: ({ value }) => {
        if (!canEdit || mutation.isPending) {
          return;
        }
        if (
          Object.keys(timePolicyPatch({ original: settings, next: value }))
            .length === 0
        ) {
          return;
        }
        mutation.mutate(value);
      },
    }),
  );
  const dirty = useSelector(form.store, (state) => state.isDirty);
  const disabled = !canEdit || mutation.isPending;
  const errorKey = timePolicyErrorKey(mutation.error);
  return (
    <Frame>
      <FramePanel>
        <form
          className="flex flex-col gap-4 p-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled) {
              return;
            }
            detached(form.handleSubmit(), "time-policy.submit");
          }}
        >
          <form.Field name="timeMinimumUnitMinutes">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-unit`}>
                  {t("settings.organization.timePolicy.minimumUnit")}
                </FieldLabel>
                <Select
                  disabled={disabled}
                  value={String(field.state.value)}
                  onValueChange={(value) => {
                    if (value !== null) {
                      field.handleChange(Number(value));
                    }
                  }}
                >
                  <SelectTrigger
                    id={`${id}-unit`}
                    aria-describedby={`${id}-unit-help`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {[
                      ...new Set([
                        ...TIME_UNIT_OPTIONS,
                        settings.timeMinimumUnitMinutes,
                      ]),
                    ]
                      .toSorted((a, b) => a - b)
                      .map((value) => (
                        <SelectItem key={value} value={String(value)}>
                          {t("guides.minutes", { count: format.number(value) })}
                        </SelectItem>
                      ))}
                  </SelectPopup>
                </Select>
                <p
                  className="text-muted-foreground text-xs"
                  id={`${id}-unit-help`}
                >
                  {t("settings.organization.timePolicy.minimumUnitHelp")}
                </p>
              </Field>
            )}
          </form.Field>
          <form.Field name="timeEditWindowDays">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-window`}>
                  {t("settings.organization.timePolicy.editWindow")}
                </FieldLabel>
                <Input
                  aria-describedby={`${id}-window-help`}
                  disabled={disabled}
                  id={`${id}-window`}
                  inputMode="numeric"
                  min={0}
                  step={1}
                  type="number"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <p
                  className="text-muted-foreground text-xs"
                  id={`${id}-window-help`}
                >
                  {t("settings.organization.timePolicy.editWindowHelp")}
                </p>
                {field.state.meta.errors.map(
                  (error) =>
                    error && (
                      <p
                        className="text-destructive text-sm"
                        key={error.message}
                        role="alert"
                      >
                        {error.message}
                      </p>
                    ),
                )}
              </Field>
            )}
          </form.Field>
          <form.Field name="timeLockedThroughMonth">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-month`}>
                  {t("settings.organization.timePolicy.lockedThrough")}
                </FieldLabel>
                <div className="flex items-center gap-2">
                  <MonthLockPicker
                    describedBy={`${id}-month-help`}
                    disabled={disabled}
                    id={`${id}-month`}
                    today={today}
                    value={field.state.value}
                    onChange={field.handleChange}
                  />
                  <Button
                    disabled={disabled || field.state.value === ""}
                    onClick={() => field.handleChange("")}
                    type="button"
                    variant="ghost"
                  >
                    {t("common.clearDate")}
                  </Button>
                </div>
                <p
                  className="text-muted-foreground text-xs"
                  id={`${id}-month-help`}
                >
                  {t("settings.organization.timePolicy.lockedThroughHelp")}
                </p>
                {field.state.meta.errors.map(
                  (error) =>
                    error && (
                      <p
                        className="text-destructive text-sm"
                        key={error.message}
                        role="alert"
                      >
                        {error.message}
                      </p>
                    ),
                )}
              </Field>
            )}
          </form.Field>
          <form.Field name="timeNarrativeRequired">
            {(field) => (
              <Field className="min-h-11 flex-row items-center gap-2">
                <Switch
                  disabled={disabled}
                  id={`${id}-narrative`}
                  checked={field.state.value}
                  onCheckedChange={field.handleChange}
                />
                <FieldLabel htmlFor={`${id}-narrative`}>
                  {t("settings.organization.timePolicy.narrativeRequired")}
                </FieldLabel>
              </Field>
            )}
          </form.Field>
          {mutation.error !== null && (
            <p className="text-destructive text-sm" role="alert">
              {errorKey === null ? mutation.error.message : t(errorKey)}
            </p>
          )}
          {canEdit && (
            <Button
              className="self-start"
              disabled={!dirty || mutation.isPending}
              type="submit"
            >
              {t("common.saveChanges")}
            </Button>
          )}
        </form>
      </FramePanel>
    </Frame>
  );
};
