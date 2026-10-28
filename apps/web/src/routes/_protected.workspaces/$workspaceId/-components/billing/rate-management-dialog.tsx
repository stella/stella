import { useId, useState } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  CURRENCY_CODE_LENGTH,
  currencyCodeSchema,
} from "@stll/api-contract/currency-code";
import { DEFAULT_VARCHAR_MAX_LENGTH } from "@stll/api-contract/limits";
import { tryToMinorUnits } from "@stll/money";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Dialog, DialogPopup } from "@stll/ui/dialog";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { ArrowLeftIcon, PlusIcon, StarIcon, TrashIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";

import { formatCurrencyAmount } from "@/components/billing/format-currency";
import { DatePickerPopover } from "@/components/date-picker-popover";
import { MEMBER_CHOICE, MemberCombobox } from "@/components/member-combobox";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { UserIdentity } from "@/components/user-avatar";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { apiFieldIssueMessage, unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { localISODate } from "@/lib/local-iso-date";
import type { NonEmptyPatch } from "@/lib/mutation-command";
import { organizationOptions } from "@/lib/organization/queries";
import { queryView } from "@/lib/query-view.logic";
import { toSafeId } from "@/lib/safe-id";
import {
  requiredTrimmedStringSchema,
  schemaFormOptions,
  toFormErrors,
} from "@/lib/schema";
import {
  rateEntriesOptions,
  rateTablesOptions,
} from "@/lib/workspaces/queries/rates";

type RateManagementDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
};

export const RateManagementDialog = ({
  open,
  onOpenChange,
  workspaceId,
}: RateManagementDialogProps) => {
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);

  return (
    <Dialog
      onOpenChange={(val) => {
        if (!val) {
          setSelectedTableId(null);
        }
        onOpenChange(val);
      }}
      open={open}
    >
      <DialogPopup className="max-w-lg">
        <div className="p-4">
          {selectedTableId ? (
            <RateEntriesView
              onBack={() => setSelectedTableId(null)}
              rateTableId={selectedTableId}
              workspaceId={workspaceId}
            />
          ) : (
            <RateTablesView
              onSelectTable={setSelectedTableId}
              workspaceId={workspaceId}
            />
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
};

// --- Rate Tables List ---

const RateTablesView = ({
  workspaceId,
  onSelectTable,
}: {
  workspaceId: string;
  onSelectTable: (id: string) => void;
}) => {
  const t = useTranslations();
  const [showForm, setShowForm] = useState(false);

  const { data: tables } = useSuspenseQuery(rateTablesOptions(workspaceId));
  const analytics = useAnalytics();

  const createTable = useMutation({
    mutationFn: async ({
      workspaceId: ws,
      ...body
    }: {
      workspaceId: string;
      name: string;
      currency: string;
      isDefault?: boolean;
    }) => {
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(ws) })
        .put({
          ...body,
        });

      return unwrapApiResponse(response);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "RateTablesView:failure",
        scope: { type: "handler", handlerId: "RateTablesView:failure" },
      });
    },
  });
  const deleteTable = useMutation({
    mutationFn: async ({
      workspaceId: ws,
      id,
    }: {
      workspaceId: string;
      id: string;
    }) => {
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(ws) })
        .delete({
          id: toSafeId<"rateTable">(id),
        });

      return unwrapApiResponse(response);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "RateTablesView:failure-2",
        scope: { type: "handler", handlerId: "RateTablesView:failure-2" },
      });
    },
  });
  type UpdateRateTableVars = {
    workspaceId: string;
    id: string;
  } & NonEmptyPatch<{
    name: string;
    currency: string;
    isDefault: boolean;
  }>;

  const updateTable = useMutation({
    mutationFn: async ({ workspaceId: ws, ...body }: UpdateRateTableVars) => {
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(ws) })
        .patch({
          ...body,
          id: toSafeId<"rateTable">(body.id),
        });

      return unwrapApiResponse(response);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "RateTablesView:failure-3",
        scope: { type: "handler", handlerId: "RateTablesView:failure-3" },
      });
    },
  });

  // The form awaits the outcome: undefined closes it, a message marks the name
  // field. A named handler rather than an inline async callback, so the form
  // owns the promise instead of the JSX dropping it.
  const submitRateTable: Parameters<
    typeof CreateRateTableForm
  >[0]["onSubmit"] = async (values) =>
    await createTable.mutateAsync({ workspaceId, ...values }).then(
      () => {
        setShowForm(false);
        return undefined;
      },
      (error: unknown) => {
        notifyUserError(error, t("common.somethingWentWrong"));
        return apiFieldIssueMessage(error, "name");
      },
    );

  const handleSetDefault = (id: string) => {
    updateTable.mutate(
      { workspaceId, id, isDefault: true },
      {
        onError: (error) => {
          notifyUserError(error, t("common.somethingWentWrong"));
        },
      },
    );
  };

  const handleDelete = (id: string) => {
    deleteTable.mutate(
      { workspaceId, id },
      {
        onError: (error) => {
          notifyUserError(error, t("common.somethingWentWrong"));
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between pe-6">
        <h3 className="text-sm font-medium">{t("billing.rates.rateTables")}</h3>
        <Button
          onClick={() => setShowForm(!showForm)}
          size="sm"
          variant="outline"
        >
          <PlusIcon className="size-4" />
          {t("billing.rates.createRateTable")}
        </Button>
      </div>

      {showForm && (
        <CreateRateTableForm
          onCancel={() => setShowForm(false)}
          onSubmit={submitRateTable}
        />
      )}

      {tables.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {tables.map((table) => (
            <div
              className="group hover:bg-muted/50 flex items-center gap-3 rounded-md border px-3 py-2"
              key={table.id}
            >
              <button
                className="flex min-w-0 flex-1 flex-col gap-0.5 text-start"
                onClick={() => onSelectTable(table.id)}
                type="button"
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {table.name}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {table.currency}
                  </span>
                  {table.isDefault && (
                    <StarIcon className="fill-warning text-warning size-3 shrink-0" />
                  )}
                </div>
                <span className="text-muted-foreground text-xs">
                  {t("billing.rates.rateCount", {
                    count: table.entryCount,
                  })}
                </span>
              </button>

              <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100">
                {!table.isDefault && (
                  <Button
                    className="size-7"
                    onClick={() => handleSetDefault(table.id)}
                    size="icon"
                    title={t("billing.rates.setAsDefault")}
                    variant="ghost"
                  >
                    <StarIcon className="size-3.5" />
                  </Button>
                )}
                <Button
                  aria-label={t("common.delete")}
                  className="size-7"
                  onClick={() => handleDelete(table.id)}
                  size="icon"
                  variant="destructive-ghost"
                >
                  <TrashIcon className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        !showForm && (
          <div className="text-muted-foreground py-8 text-center text-sm">
            {t("billing.rates.noRateTables")}
          </div>
        )
      )}
    </div>
  );
};

// --- Create Rate Table Form ---

export const CreateRateTableForm = ({
  onSubmit,
  onCancel,
}: {
  /** Resolves with the server's message for the name when it rejected it. */
  onSubmit: (values: {
    name: string;
    currency: string;
    isDefault?: boolean;
  }) => Promise<string | undefined>;
  onCancel: () => void;
}) => {
  const t = useTranslations();
  const schema = v.strictObject({
    name: requiredTrimmedStringSchema(t("common.required")),
    // One message per field: stop at the first failing currency check.
    currency: v.config(
      v.message(
        currencyCodeSchema,
        t("billing.sellerProfiles.invalidCurrency"),
      ),
      { abortPipeEarly: true },
    ),
    isDefault: v.boolean(),
  });

  const form = useForm(
    schemaFormOptions({
      schema,
      submitValues: "schema-output",
      defaultValues: {
        name: "",
        currency: "USD",
        isDefault: false,
      },
      onSubmit: async ({ value, formApi }) => {
        const nameIssue = await onSubmit(value);
        if (nameIssue !== undefined) {
          formApi.setErrorMap({
            onSubmit: { fields: { name: nameIssue } },
          });
        }
      },
    }),
  );
  const { formErrors, dirty } = useSelector(form.store, (state) => ({
    formErrors: toFormErrors(state.fieldMeta),
    dirty: !state.isDefaultValue,
  }));

  return (
    <Form
      dirty={dirty}
      onDiscard={() => form.reset()}
      className="flex flex-col gap-3 rounded-md border p-3"
      errors={formErrors}
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        detached(form.handleSubmit(), "rate-management-dialog.submit");
      }}
    >
      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <form.Field name="name">
            {(field) => (
              <Field className="w-full gap-1.5" name={field.name}>
                <FieldLabel>{t("common.name")}</FieldLabel>
                <Input
                  autoFocus
                  maxLength={DEFAULT_VARCHAR_MAX_LENGTH}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.currentTarget.value)}
                  placeholder={t("billing.rates.tableNamePlaceholder")}
                  value={field.state.value}
                />
                <FieldError />
              </Field>
            )}
          </form.Field>
        </div>
        <form.Field name="currency">
          {(field) => (
            <Field className="w-24 gap-1.5" name={field.name}>
              <FieldLabel>{t("common.currency")}</FieldLabel>
              <Input
                dir="ltr"
                maxLength={CURRENCY_CODE_LENGTH}
                onChange={(e) =>
                  field.handleChange(e.currentTarget.value.toUpperCase())
                }
                value={field.state.value}
              />
              <FieldError />
            </Field>
          )}
        </form.Field>
      </div>

      <form.Field name="isDefault">
        {(field) => (
          <div className="flex items-center gap-2">
            <Checkbox
              checked={field.state.value}
              onCheckedChange={(checked) => field.handleChange(checked)}
            />
            <Label>{t("billing.rates.setAsDefault")}</Label>
          </div>
        )}
      </form.Field>

      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} size="sm" type="button" variant="outline">
          {t("common.cancel")}
        </Button>
        <Button size="sm" type="submit">
          {t("common.save")}
        </Button>
      </div>
    </Form>
  );
};

// --- Rate Entries View ---

const RateEntriesView = ({
  workspaceId,
  rateTableId,
  onBack,
}: {
  workspaceId: string;
  rateTableId: string;
  onBack: () => void;
}) => {
  const t = useTranslations();
  const [showForm, setShowForm] = useState(false);
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;

  const { data: tables } = useSuspenseQuery(rateTablesOptions(workspaceId));
  const entriesQuery = useQuery(rateEntriesOptions(workspaceId, rateTableId));
  const entriesView = queryView(entriesQuery);
  const entries = entriesView.type === "items" ? entriesView.items : undefined;
  const { data: org } = useSuspenseQuery(
    organizationOptions(activeOrganizationId),
  );

  const table = tables.find((tbl) => tbl.id === rateTableId);
  const analytics = useAnalytics();

  const createEntry = useMutation({
    mutationFn: async ({
      workspaceId: ws,
      rateTableId: rtId,
      ...body
    }: {
      workspaceId: string;
      rateTableId: string;
      userId?: string | null;
      hourlyRate: number;
      effectiveFrom: string;
      effectiveTo?: string | null;
    }) => {
      const { userId, ...restBody } = body;
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(ws) })({
          rateTableId: toSafeId<"rateTable">(rtId),
        })
        .entries.put({
          ...restBody,
          ...(userId !== undefined && {
            userId: userId === null ? null : toSafeId<"user">(userId),
          }),
        });

      return unwrapApiResponse(response);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "RateEntriesView:failure",
        scope: { type: "handler", handlerId: "RateEntriesView:failure" },
      });
    },
  });
  const deleteEntry = useMutation({
    mutationFn: async ({
      workspaceId: ws,
      rateTableId: rtId,
      id,
    }: {
      workspaceId: string;
      rateTableId: string;
      id: string;
    }) => {
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(ws) })({
          rateTableId: toSafeId<"rateTable">(rtId),
        })
        .entries.delete({
          id: toSafeId<"rateEntry">(id),
        });

      return unwrapApiResponse(response);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "RateEntriesView:failure-2",
        scope: { type: "handler", handlerId: "RateEntriesView:failure-2" },
      });
    },
  });

  const members = org.members;

  const handleDelete = (id: string) => {
    deleteEntry.mutate(
      { workspaceId, rateTableId, id },
      {
        onError: (error) => {
          notifyUserError(error, t("common.somethingWentWrong"));
        },
      },
    );
  };

  const today = localISODate();

  return (
    <div className="flex flex-col gap-4">
      <QueryViewFeedback view={entriesView} />
      <div className="flex items-center gap-2">
        <Button
          aria-label={t("common.back")}
          className="size-7"
          onClick={onBack}
          size="icon"
          variant="ghost"
        >
          <DirectionalIcon className="size-4" icon={ArrowLeftIcon} />
        </Button>
        <h3 className="text-sm font-medium">
          {table?.name ?? t("billing.rates.rateEntries")}
        </h3>
        {table && (
          <span className="text-muted-foreground text-xs">
            {`(${table.currency})`}
          </span>
        )}
      </div>

      <Button
        className="self-end"
        onClick={() => setShowForm(!showForm)}
        size="sm"
        variant="outline"
      >
        <PlusIcon className="size-4" />
        {t("billing.rates.addRate")}
      </Button>

      {showForm && (
        <CreateRateEntryForm
          currency={table?.currency ?? "USD"}
          members={members}
          onCancel={() => setShowForm(false)}
          onSubmit={(values) => {
            createEntry.mutate(
              { workspaceId, rateTableId, ...values },
              {
                onSuccess: () => setShowForm(false),
                onError: (error) => {
                  notifyUserError(error, t("common.somethingWentWrong"));
                },
              },
            );
          }}
          today={today}
        />
      )}

      {entries && entries.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <div
              className="group flex items-center gap-3 rounded-md border px-3 py-2"
              key={entry.id}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {entry.userId ? (
                  <div className="flex items-center gap-2">
                    <UserIdentity
                      avatarClassName="size-7 shrink-0 text-3xs"
                      image={entry.userImage}
                      name={entry.userName}
                    />
                    <span className="text-sm tabular-nums">
                      {formatCurrencyAmount(
                        entry.hourlyRate,
                        table?.currency ?? "USD",
                      )}
                      {t("billing.rates.perHour")}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {t("billing.rates.defaultRate")}
                    </span>
                    <span className="text-sm tabular-nums">
                      {formatCurrencyAmount(
                        entry.hourlyRate,
                        table?.currency ?? "USD",
                      )}
                      {t("billing.rates.perHour")}
                    </span>
                  </div>
                )}
                <span className="text-muted-foreground text-xs">
                  {entry.effectiveFrom}
                  {entry.effectiveTo
                    ? ` — ${entry.effectiveTo}`
                    : ` — ${t("billing.rates.ongoing")}`}
                </span>
              </div>

              <Button
                aria-label={t("common.delete")}
                className="size-7 opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100"
                onClick={() => handleDelete(entry.id)}
                size="icon"
                variant="destructive-ghost"
              >
                <TrashIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        !showForm &&
        (entriesView.type === "items" || entriesView.type === "empty") && (
          <div className="text-muted-foreground py-6 text-center text-sm">
            {t("billing.rates.noRateEntries")}
          </div>
        )
      )}
    </div>
  );
};

// --- Create Rate Entry Form ---

type Member = {
  id: string;
  userId: string;
  user: { email: string; image?: string | null | undefined; name: string };
};

const CreateRateEntryForm = ({
  members,
  currency,
  today,
  onSubmit,
  onCancel,
}: {
  members: Member[];
  currency: string;
  today: string;
  onSubmit: (values: {
    userId?: string | null;
    hourlyRate: number;
    effectiveFrom: string;
    effectiveTo?: string | null;
  }) => void;
  onCancel: () => void;
}) => {
  const t = useTranslations();
  const userFieldId = useId();
  const memberOptions = members.map((member) => ({
    email: member.user.email,
    image: member.user.image ?? null,
    name: member.user.name,
    userId: member.userId,
  }));
  const schema = v.strictObject({
    userId: v.pipe(
      v.string(),
      v.transform((value) => value || null),
    ),
    // The typed text is scaled directly rather than through a parsed float,
    // which would lose the cent that 1.005 should round to in USD.
    hourlyRate: v.pipe(
      v.string(),
      v.rawTransform(({ addIssue, dataset, NEVER }) => {
        const hourlyRate = tryToMinorUnits({
          amount: dataset.value,
          currency,
        });
        if (hourlyRate === null || hourlyRate < 0) {
          addIssue({ message: t("billing.hourlyRateMustBeNonNegative") });
          return NEVER;
        }
        return hourlyRate;
      }),
    ),
    effectiveFrom: v.string(),
    effectiveTo: v.pipe(
      v.string(),
      v.transform((value) => value || null),
    ),
  });

  const form = useForm(
    schemaFormOptions({
      schema,
      submitValues: "schema-output",
      defaultValues: {
        userId: "",
        hourlyRate: "",
        effectiveFrom: today,
        effectiveTo: "",
      },
      onSubmit: ({ value }) => {
        onSubmit(value);
      },
    }),
  );
  const { formErrors, dirty } = useSelector(form.store, (state) => ({
    formErrors: toFormErrors(state.fieldMeta),
    dirty: !state.isDefaultValue,
  }));

  return (
    <Form
      dirty={dirty}
      onDiscard={() => form.reset()}
      className="flex flex-col gap-3 rounded-md border p-3"
      errors={formErrors}
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        detached(form.handleSubmit(), "rate-management-dialog.submit");
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={userFieldId}>{t("common.user")}</Label>
        <form.Field name="userId">
          {(field) => (
            <MemberCombobox
              choice={{
                type: MEMBER_CHOICE.memberOrNone,
                noneLabel: t("billing.rates.defaultRate"),
              }}
              id={userFieldId}
              label={t("common.user")}
              members={memberOptions}
              onValueChange={(userId) => field.handleChange(userId ?? "")}
              placeholder={t("billing.rates.defaultRate")}
              value={field.state.value || null}
            />
          )}
        </form.Field>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <form.Field name="hourlyRate">
            {(field) => (
              <Field className="w-full gap-1.5" name={field.name}>
                <FieldLabel>{`${t("billing.rates.hourlyRate")} (${currency})`}</FieldLabel>
                <Input
                  dir="ltr"
                  inputMode="decimal"
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.currentTarget.value)}
                  placeholder="350.00"
                  value={field.state.value}
                />
                <FieldError />
              </Field>
            )}
          </form.Field>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label>{t("billing.rates.effectiveFrom")}</Label>
          <form.Field name="effectiveFrom">
            {(field) => (
              <DatePickerPopover
                onChange={(value) => field.handleChange(value ?? "")}
                value={field.state.value}
              />
            )}
          </form.Field>
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <Label>{t("billing.rates.effectiveTo")}</Label>
          <form.Field name="effectiveTo">
            {(field) => (
              <DatePickerPopover
                onChange={(value) => field.handleChange(value ?? "")}
                value={field.state.value}
              />
            )}
          </form.Field>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} size="sm" type="button" variant="outline">
          {t("common.cancel")}
        </Button>
        <Button size="sm" type="submit">
          {t("common.save")}
        </Button>
      </div>
    </Form>
  );
};
