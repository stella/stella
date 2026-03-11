import { useState } from "react";

import { useForm } from "@tanstack/react-form";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, PlusIcon, StarIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Checkbox } from "@stella/ui/components/checkbox";
import { Dialog, DialogPopup } from "@stella/ui/components/dialog";
import { Input } from "@stella/ui/components/input";
import { Label } from "@stella/ui/components/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";
import { toastManager } from "@stella/ui/components/toast";

import { organizationOptions } from "@/routes/_protected.organization/-queries";
import {
  useCreateRateEntry,
  useCreateRateTable,
  useDeleteRateEntry,
  useDeleteRateTable,
  useUpdateRateTable,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/rates";
import {
  rateEntriesOptions,
  rateTablesOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/rates";

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

  const createTable = useCreateRateTable();
  const deleteTable = useDeleteRateTable();
  const updateTable = useUpdateRateTable();

  const handleSetDefault = (id: string) => {
    updateTable.mutate(
      { workspaceId, id, isDefault: true },
      {
        onError: () => {
          toastManager.add({
            title: t("common.somethingWentWrong"),
            type: "error",
          });
        },
      },
    );
  };

  const handleDelete = (id: string) => {
    deleteTable.mutate(
      { workspaceId, id },
      {
        onError: () => {
          toastManager.add({
            title: t("common.somethingWentWrong"),
            type: "error",
          });
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
          onSubmit={(values) => {
            createTable.mutate(
              { workspaceId, ...values },
              {
                onSuccess: () => setShowForm(false),
                onError: () => {
                  toastManager.add({
                    title: t("common.somethingWentWrong"),
                    type: "error",
                  });
                },
              },
            );
          }}
        />
      )}

      {tables && tables.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {tables.map((table) => (
            <div
              className="group hover:bg-muted/50 flex items-center gap-3 rounded-md border px-3 py-2 transition-colors"
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
                    <StarIcon className="size-3 shrink-0 fill-amber-400 text-amber-400" />
                  )}
                </div>
                <span className="text-muted-foreground text-xs">
                  {t("billing.rates.rateCount", {
                    count: table.entryCount,
                  })}
                </span>
              </button>

              <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
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
                  className="text-destructive size-7"
                  onClick={() => handleDelete(table.id)}
                  size="icon"
                  variant="ghost"
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

const CreateRateTableForm = ({
  onSubmit,
  onCancel,
}: {
  onSubmit: (values: {
    name: string;
    currency: string;
    isDefault?: boolean;
  }) => void;
  onCancel: () => void;
}) => {
  const t = useTranslations();

  const form = useForm({
    defaultValues: {
      name: "",
      currency: "USD",
      isDefault: false,
    },
    onSubmit: ({ value }) => {
      if (!value.name.trim()) {
        return;
      }
      onSubmit(value);
    },
  });

  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // eslint-disable-next-line typescript/no-floating-promises
        form.handleSubmit();
      }}
    >
      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label>{t("billing.rates.tableName")}</Label>
          <form.Field name="name">
            {(field) => (
              <Input
                autoFocus
                onChange={(e) => field.handleChange(e.currentTarget.value)}
                placeholder={t("billing.rates.tableNamePlaceholder")}
                value={field.state.value}
              />
            )}
          </form.Field>
        </div>
        <div className="flex w-24 flex-col gap-1.5">
          <Label>{t("billing.rates.currency")}</Label>
          <form.Field name="currency">
            {(field) => (
              <Input
                maxLength={3}
                onChange={(e) =>
                  field.handleChange(e.currentTarget.value.toUpperCase())
                }
                value={field.state.value}
              />
            )}
          </form.Field>
        </div>
      </div>

      <form.Field name="isDefault">
        {(field) => (
          <div className="flex items-center gap-2">
            <Checkbox
              checked={field.state.value}
              onCheckedChange={(checked) =>
                field.handleChange(Boolean(checked))
              }
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
    </form>
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

  const { data: tables } = useSuspenseQuery(rateTablesOptions(workspaceId));
  const { data: entries } = useQuery(
    rateEntriesOptions(workspaceId, rateTableId),
  );
  const { data: org } = useSuspenseQuery(organizationOptions);

  const table = tables?.find((tbl) => tbl.id === rateTableId);

  const createEntry = useCreateRateEntry();
  const deleteEntry = useDeleteRateEntry();

  const members = org?.members ?? [];

  const handleDelete = (id: string) => {
    deleteEntry.mutate(
      { workspaceId, rateTableId, id },
      {
        onError: () => {
          toastManager.add({
            title: t("common.somethingWentWrong"),
            type: "error",
          });
        },
      },
    );
  };

  const today = (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button className="size-7" onClick={onBack} size="icon" variant="ghost">
          <ArrowLeftIcon className="size-4" />
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
                onError: () => {
                  toastManager.add({
                    title: t("common.somethingWentWrong"),
                    type: "error",
                  });
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
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {entry.userName ?? t("billing.rates.defaultRate")}
                  </span>
                  <span className="text-sm tabular-nums">
                    {formatCurrency(entry.hourlyRate, table?.currency ?? "USD")}
                    {t("billing.rates.perHour")}
                  </span>
                </div>
                <span className="text-muted-foreground text-xs">
                  {entry.effectiveFrom}
                  {entry.effectiveTo
                    ? ` — ${entry.effectiveTo}`
                    : ` — ${t("billing.rates.ongoing")}`}
                </span>
              </div>

              <Button
                className="text-destructive size-7 opacity-0 transition-opacity group-hover:opacity-100"
                onClick={() => handleDelete(entry.id)}
                size="icon"
                variant="ghost"
              >
                <TrashIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        !showForm && (
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
  user: { name: string; email: string };
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

  const form = useForm({
    defaultValues: {
      userId: "" as string,
      hourlyRate: "",
      effectiveFrom: today,
      effectiveTo: "",
    },
    onSubmit: ({ value }) => {
      const rateNum = Math.round(Number.parseFloat(value.hourlyRate) * 100);

      if (Number.isNaN(rateNum) || rateNum < 0) {
        return;
      }

      onSubmit({
        userId: value.userId || null,
        hourlyRate: rateNum,
        effectiveFrom: value.effectiveFrom,
        effectiveTo: value.effectiveTo || null,
      });
    },
  });

  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // eslint-disable-next-line typescript/no-floating-promises
        form.handleSubmit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label>{t("common.user")}</Label>
        <form.Field name="userId">
          {(field) => (
            <Select
              onValueChange={(val) => field.handleChange(val ?? "")}
              value={field.state.value}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("billing.rates.defaultRate")} />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="">
                  {t("billing.rates.defaultRate")}
                </SelectItem>
                {members.map((member) => (
                  <SelectItem key={member.userId} value={member.userId}>
                    {member.user.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
        </form.Field>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label>{`${t("billing.rates.hourlyRate")} (${currency})`}</Label>
          <form.Field name="hourlyRate">
            {(field) => (
              <Input
                inputMode="decimal"
                onChange={(e) => field.handleChange(e.currentTarget.value)}
                placeholder="350.00"
                value={field.state.value}
              />
            )}
          </form.Field>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label>{t("billing.rates.effectiveFrom")}</Label>
          <form.Field name="effectiveFrom">
            {(field) => (
              <Input
                onChange={(e) => field.handleChange(e.currentTarget.value)}
                type="date"
                value={field.state.value}
              />
            )}
          </form.Field>
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <Label>{t("billing.rates.effectiveTo")}</Label>
          <form.Field name="effectiveTo">
            {(field) => (
              <Input
                onChange={(e) => field.handleChange(e.currentTarget.value)}
                type="date"
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
    </form>
  );
};

// --- Helpers ---

const formatCurrency = (cents: number, currency: string): string => {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
};
