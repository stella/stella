import { useState } from "react";

import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";
import { stellaToast } from "@stll/ui/toast";

import { dailyTargetFormSchema } from "@/features/time-timers/day-totals.logic";
import { usePermissions } from "@/hooks/use-permissions";
import { useAnalytics } from "@/lib/analytics/provider";
import { myTimeEntriesApi } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { schemaFormOptions } from "@/lib/schema";
import { formatMinutes } from "@/lib/workspaces/format-duration";
import { myTimeEntriesKeys } from "@/lib/workspaces/queries/my-time-entries";

type DayTotalsProps = {
  loggedTodayMinutes: number;
  dailyTargetMinutes: number | null;
  leftTodayMinutes: number | null;
};

export const DayTotals = ({
  loggedTodayMinutes,
  dailyTargetMinutes,
  leftTodayMinutes,
}: DayTotalsProps) => {
  const t = useTranslations();
  const canEdit = usePermissions({ timeEntry: ["create"] });
  const [editor, setEditor] = useState<{ initialTarget: number | null } | null>(
    null,
  );
  return (
    <section className="flex flex-col gap-3 border-t pt-3">
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">
            {t("billing.globalTimer.loggedToday")}
          </dt>
          <dd className="tabular-nums">{formatMinutes(loggedTodayMinutes)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("billing.globalTimer.leftToday")}
          </dt>
          <dd className="tabular-nums">
            {leftTodayMinutes === null
              ? t("billing.globalTimer.noDailyTarget")
              : formatMinutes(leftTodayMinutes)}
          </dd>
        </div>
      </dl>
      {canEdit &&
        (editor === null ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setEditor({ initialTarget: dailyTargetMinutes })}
          >
            {t("billing.globalTimer.dailyTarget")}
          </Button>
        ) : (
          <DailyTargetForm
            initialTarget={editor.initialTarget}
            onDone={() => setEditor(null)}
          />
        ))}
    </section>
  );
};

type DailyTargetFormProps = {
  initialTarget: number | null;
  onDone: () => void;
};

const DailyTargetForm = ({ initialTarget, onDone }: DailyTargetFormProps) => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (minutes: number | null) =>
      unwrapEden(await myTimeEntriesApi["daily-target"].post({ minutes })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: myTimeEntriesKeys.all(user.activeOrganizationId),
      });
      onDone();
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        type: "error",
        title: t("common.somethingWentWrong"),
        description: error.message,
      });
    },
  });
  const form = useForm(
    schemaFormOptions({
      defaultValues: {
        minutes: initialTarget === null ? "" : String(initialTarget),
      },
      schema: dailyTargetFormSchema(
        t("billing.globalTimer.invalidDailyTarget"),
      ),
      submitValues: "schema-output",
      onSubmit: ({ value }) => {
        if (mutation.isPending) {
          return;
        }
        mutation.mutate(value.minutes);
      },
    }),
  );
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        if (mutation.isPending) {
          return;
        }
        detached(form.handleSubmit(), "daily-target.submit");
      }}
    >
      <form.Field name="minutes">
        {(field) => (
          <Field name={field.name} invalid={field.state.meta.errors.length > 0}>
            <FieldLabel>{t("billing.globalTimer.dailyTarget")}</FieldLabel>
            <Input
              dir="ltr"
              inputMode="numeric"
              value={field.state.value}
              disabled={mutation.isPending}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            <FieldDescription>
              {t("billing.globalTimer.targetHelp")}
            </FieldDescription>
            {field.state.meta.errors.map(
              (error) =>
                error && (
                  <FieldError match key={error.message}>
                    {error.message}
                  </FieldError>
                ),
            )}
          </Field>
        )}
      </form.Field>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={mutation.isPending}
          onClick={onDone}
        >
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {t("common.save")}
        </Button>
      </div>
    </Form>
  );
};
