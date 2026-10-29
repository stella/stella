import { useState } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import type * as v from "valibot";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";
import { BPS_PER_PERCENTAGE_POINT } from "@stll/api-contract/billing";
import { CURRENCY_CODE_LENGTH } from "@stll/api-contract/currency-code";
import { Button } from "@stll/ui/button";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";

import { majorUnitInput } from "@/components/billing/amount-input.logic";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useCapabilityMutation } from "@/lib/capabilities/use-capability-mutation";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { ratesQueryRoot } from "@/lib/resource-query-roots.logic";
import { toSafeId } from "@/lib/safe-id";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";

import { hourlyArrangementSchema } from "./billing-arrangement-editor.logic";

const arrangementKeys = { all: ratesQueryRoot };

const arrangementOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: [...arrangementKeys.all(workspaceId), "arrangement"],
    queryFn: async ({ signal }) =>
      unwrapApiResponse(
        await api
          .rates({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .arrangement.get({ fetch: { signal } }),
      ),
  });

type Arrangement =
  NonNullable<ReturnType<typeof arrangementOptions>["queryFn"]> extends (
    ...args: never[]
  ) => infer Response
    ? Awaited<Response> extends { arrangement: infer Value }
      ? Value
      : never
    : never;

export const BillingArrangementEditor = ({
  workspaceId,
}: {
  workspaceId: string;
}) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const view = queryView(
    useQuery({ ...arrangementOptions(workspaceId), enabled: open }),
  );
  return (
    <details
      className="rounded-md border p-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        {t("billing.arrangement.title")}
      </summary>
      {open && <QueryViewFeedback view={view} />}
      {view.type === "items" &&
        (view.items.arrangement?.mode === "flat_fee" ? (
          <p className="text-muted-foreground mt-3 text-sm">
            {t("billing.arrangement.flatFee")}
          </p>
        ) : (
          <HourlyArrangementForm
            key={view.items.arrangement?.revision ?? "initial"}
            arrangement={view.items.arrangement}
            workspaceId={workspaceId}
          />
        ))}
    </details>
  );
};

const HourlyArrangementForm = ({
  arrangement,
  workspaceId,
}: {
  arrangement: Arrangement;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const save = useCapabilityMutation({
    capability: "rates.arrangement.update",
    target: resourceRef({
      type: RESOURCE_TYPE.WORKSPACE,
      id: toSafeId<"workspace">(workspaceId),
    }),
    mutationFn: async (
      body: v.InferOutput<ReturnType<typeof hourlyArrangementSchema>>,
      request,
    ) =>
      unwrapApiResponse(
        await api
          .rates({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .arrangement.put(
            {
              mode: "hourly",
              ...body,
              ...(arrangement && { revision: arrangement.revision }),
            },
            request,
          ),
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData(arrangementOptions(workspaceId).queryKey, {
        arrangement: saved,
      });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "HourlyArrangementForm:save",
        scope: { type: "handler", handlerId: "HourlyArrangementForm:save" },
      });
      notifyUserError(error, t("common.somethingWentWrong"));
    },
  });
  const hourly = arrangement?.mode === "hourly" ? arrangement : null;
  const currency = hourly?.currency ?? "USD";
  const schema = hourlyArrangementSchema(t("billing.arrangement.invalidCap"));
  const form = useForm(
    schemaFormOptions({
      schema,
      submitValues: "schema-output",
      defaultValues: {
        currency,
        capAmount:
          hourly && "capAmount" in hourly
            ? majorUnitInput(hourly.capAmount, currency)
            : "",
        capMinutes:
          hourly && "capMinutes" in hourly ? `${hourly.capMinutes}` : "",
        alertThreshold:
          hourly && "alertThresholdBps" in hourly
            ? `${hourly.alertThresholdBps / BPS_PER_PERCENTAGE_POINT}`
            : "80",
      },
      onSubmit: async ({ value }) => {
        await save.mutateAsync(value);
      },
    }),
  );
  const { errors, dirty } = useSelector(form.store, (state) => ({
    errors: toFormErrors(state.fieldMeta),
    dirty: !state.isDefaultValue,
  }));
  return (
    <Form
      className="mt-3 flex flex-col gap-3"
      dirty={dirty}
      onDiscard={() => form.reset()}
      errors={errors}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        detached(form.handleSubmit(), "billing-arrangement-editor.submit");
      }}
    >
      {(
        [
          { name: "currency", label: "common.currency", mode: "text" },
          {
            name: "capAmount",
            label: "billing.arrangement.amountCap",
            mode: "decimal",
          },
          {
            name: "capMinutes",
            label: "billing.arrangement.minuteCap",
            mode: "numeric",
          },
          {
            name: "alertThreshold",
            label: "billing.arrangement.alertThreshold",
            mode: "decimal",
          },
        ] as const
      ).map(({ name, label, mode }) => (
        <form.Field key={name} name={name}>
          {(field) => (
            <Field name={field.name}>
              <FieldLabel>{t(label)}</FieldLabel>
              <Input
                dir="ltr"
                inputMode={mode}
                maxLength={
                  name === "currency" ? CURRENCY_CODE_LENGTH : undefined
                }
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) =>
                  field.handleChange(
                    name === "currency"
                      ? event.currentTarget.value.toUpperCase()
                      : event.currentTarget.value,
                  )
                }
              />
              <FieldError />
            </Field>
          )}
        </form.Field>
      ))}
      <Button
        className="self-end"
        size="sm"
        type="submit"
        disabled={save.isPending}
      >
        {t("common.save")}
      </Button>
    </Form>
  );
};
