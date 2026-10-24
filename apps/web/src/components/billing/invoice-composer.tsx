import { useState } from "react";
import type { ReactNode } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { INVOICE_DUE_DAY_PRESETS, INVOICE_LANGUAGES } from "@stll/api-contract";
import type { InvoiceLanguage } from "@stll/api-contract";
import type { InvoiceTotals, VatTreatment } from "@stll/invoicing";
import { displayLanguageName } from "@stll/locales";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CircleCheckIcon,
  InfoIcon,
} from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { MatterIcon } from "@stll/ui/matter-icon";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Switch } from "@stll/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";
import { cn } from "@stll/ui/utils";

import { formatCurrencyAmount } from "@/components/billing/format-currency";
import {
  MEDIUM_DATE,
  plainDateEpoch,
  SHORT_DATE,
} from "@/components/billing/format-plain-date";
import { InvoicePdfDownloadButton } from "@/components/billing/invoice-pdf-download-button";
import { DatePickerPopover } from "@/components/date-picker-popover";
import { useFormatter, useLocale } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { expensesQueryRoot } from "@/lib/resource-query-roots.logic";
import { toSafeId } from "@/lib/safe-id";
import {
  invoiceByIdOptions,
  invoicesKeys,
} from "@/lib/workspaces/queries/invoices";
import type {
  ClientInvoicePrefill,
  InvoicePrefill,
} from "@/lib/workspaces/queries/invoices";
import { timeEntriesKeys } from "@/lib/workspaces/queries/time-entries";

import {
  composeTotals,
  dueDateFor,
  editableHoursText,
  entryAdjustments,
  entryAmount,
  entryChoice,
  expenseAmount,
  hasBillableItems,
  includedExpenseIdsOf,
  includedMinutes,
  lastIncludedWorkDate,
  parseHoursInput,
  submitComposedInvoice,
  vatOnSupplyDate,
} from "./invoice-composer.logic";
import type {
  ComposerVatDecision,
  EntryChoice,
} from "./invoice-composer.logic";

type ComposerStep = "items" | "details" | "issue";
const COMPOSER_STEPS: readonly ComposerStep[] = ["items", "details", "issue"];

const STEP_LABELS = {
  items: "billing.invoiceComposer.steps.items",
  details: "common.details",
  issue: "billing.invoiceComposer.steps.issue",
} as const satisfies Record<ComposerStep, TranslationKey>;

const VAT_TREATMENT_LABELS = {
  domestic_vat: "billing.invoiceComposer.noVat",
  not_vat_payer: "billing.invoiceComposer.noVat",
  exempt: "billing.invoiceComposer.noVat",
  reverse_charge: "billing.invoiceComposer.reverseCharge",
  outside_scope: "billing.invoiceComposer.outsideScope",
} as const satisfies Record<VatTreatment, TranslationKey>;

const VAT_REASON_LABELS = {
  no_seller_profile: "billing.invoiceComposer.vatReasons.noSellerProfile",
  seller_not_vat_payer: "billing.invoiceComposer.vatReasons.sellerNotVatPayer",
  reverse_charge: "billing.invoiceComposer.vatReasons.reverseCharge",
  outside_scope: "billing.invoiceComposer.vatReasons.outsideScope",
  domestic_rate: "billing.invoiceComposer.vatReasons.domesticRate",
  no_vat_rate: "billing.invoiceComposer.vatReasons.noVatRate",
  client_country_unconfirmed:
    "billing.invoiceComposer.vatReasons.clientCountryUnconfirmed",
  client_vat_id_invalid:
    "billing.invoiceComposer.vatReasons.clientVatIdInvalid",
} as const satisfies Record<InvoicePrefill["vat"]["reason"], TranslationKey>;

type PrefillEntry = InvoicePrefill["timeEntries"][number];
type PrefillExpense = InvoicePrefill["expenses"][number];

type IssuedInvoice = {
  id: string;
  invoiceNumber: string | null;
  issued: boolean;
  totalAmount: number;
  currency: string;
  dueDate: string | null;
};

const isInvoiceLanguage = (value: string | null): value is InvoiceLanguage =>
  INVOICE_LANGUAGES.some((language) => language === value);

/** A muted note saying where a prefilled value came from. */
const SourceHint = ({ children }: { children: ReactNode }) => (
  <span className="text-muted-foreground text-xs">{children}</span>
);

const Callout = ({ children }: { children: ReactNode }) => (
  <div className="bg-muted text-muted-foreground flex items-start gap-2 rounded-lg px-3 py-2 text-sm">
    <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
    <span>{children}</span>
  </div>
);

/** Text dimmed while its row is left off the invoice. */
const RowText = ({
  excluded,
  className,
  children,
}: {
  excluded: boolean;
  className?: string;
  children: ReactNode;
}) => (
  <span className={cn(excluded && "text-foreground-disabled", className)}>
    {children}
  </span>
);

type ClientComposerMatter = ClientInvoicePrefill["matters"][number];

type ClientComposer = {
  clientId: string;
  matters: readonly ClientComposerMatter[];
};

type InvoiceComposerProps = {
  client?: ClientComposer;
  workspaceId: string;
  prefill: InvoicePrefill;
};

/**
 * Three steps from a matter's unbilled work to an issued invoice: choose and
 * adjust the items, check the prefilled details, then issue. Nothing is
 * written until "Save as draft" or "Issue invoice"; the totals shown are the
 * totals the invoice gets, computed by the same calculation the API runs.
 */
export const InvoiceComposer = ({
  workspaceId,
  prefill,
  client,
}: InvoiceComposerProps) => {
  const t = useTranslations();
  const currency = prefill.currency;
  const flatFee = prefill.billingMode === "flat_fee";
  const entries = prefill.timeEntries.filter(
    (entry) => entry.currency === currency,
  );
  const expenses = flatFee
    ? []
    : prefill.expenses.filter((expense) => expense.currency === currency);

  const [step, setStep] = useState<ComposerStep>("items");
  const [choices, setChoices] = useState<ReadonlyMap<string, EntryChoice>>(
    () => new Map(),
  );
  const [includedExpenseIds, setIncludedExpenseIds] = useState<
    ReadonlySet<string>
  >(() => new Set(expenses.map((expense) => expense.id)));
  const [invoiceDate, setInvoiceDate] = useState(prefill.invoiceDate);
  const [dueDays, setDueDays] = useState(prefill.dueDays);
  const [language, setLanguage] = useState(prefill.language);
  const [issued, setIssued] = useState<IssuedInvoice | null>(null);

  const selection = { entries, choices, expenses, includedExpenseIds };
  const supplyDate = lastIncludedWorkDate(selection) ?? invoiceDate;
  const vat = vatOnSupplyDate(prefill.vat, prefill.vatRatePeriods, supplyDate);
  const totals = composeTotals({
    ...selection,
    vat: { vatTreatment: vat.vatTreatment, vatRateBps: vat.vatRateBps },
    flatFeeAmount: prefill.flatFeeAmount,
  });
  const dueDate = dueDateFor(invoiceDate, dueDays);
  const includedExpenses = includedExpenseIdsOf(expenses, includedExpenseIds);
  const includedEntryIds = entries
    .filter((entry) => entryChoice(choices, entry).included)
    .map((entry) => entry.id);
  const hasItems = hasBillableItems({
    flatFeeAmount: prefill.flatFeeAmount,
    includedEntryCount: includedEntryIds.length,
    includedExpenseCount: includedExpenses.length,
  });

  const invoiceWorkspaceId =
    client?.matters.find(
      (matter) =>
        matter.prefill.timeEntries.some((entry) =>
          includedEntryIds.includes(entry.id),
        ) ||
        matter.prefill.expenses.some((expense) =>
          includedExpenses.includes(expense.id),
        ),
    )?.workspaceId ?? workspaceId;
  const submit = useComposerSubmit({
    workspaceId: invoiceWorkspaceId,
    ...(client === undefined ? {} : { client }),
    onDone: setIssued,
  });

  if (issued !== null) {
    return (
      <IssuedState
        buyerName={prefill.buyer.buyerName}
        invoice={issued}
        workspaceId={invoiceWorkspaceId}
      />
    );
  }

  if (
    currency === null ||
    (prefill.flatFeeAmount === null &&
      entries.length === 0 &&
      expenses.length === 0)
  ) {
    return (
      <div className="text-muted-foreground flex flex-col items-start gap-2 p-6 text-sm">
        <p>{t("billing.invoiceComposer.nothingToBill")}</p>
        <Link
          className="text-foreground underline underline-offset-4"
          params={{ workspaceId }}
          to="/workspaces/$workspaceId/timesheets"
        >
          {t("billing.timesheets")}
        </Link>
      </div>
    );
  }

  const send = (issue: boolean) =>
    submit.mutate({
      issue,
      body: {
        invoiceDate,
        dueDate,
        taxableSupplyDate: supplyDate,
        ...(totals === null
          ? {}
          : { expectedTotalAmount: totals.grossAmountMinor }),
        currency,
        language,
        // The seller the person reviewed, even if the default changes meanwhile.
        ...(prefill.seller === null
          ? {}
          : { sellerProfileId: toSafeId<"sellerProfile">(prefill.seller.id) }),
        timeEntryIds: includedEntryIds.map((id) => toSafeId<"timeEntry">(id)),
        expenseIds: includedExpenses.map((id) => toSafeId<"expense">(id)),
        entryAdjustments: entryAdjustments(entries, choices).map(
          (adjustment) => ({
            ...adjustment,
            timeEntryId: toSafeId<"timeEntry">(adjustment.timeEntryId),
          }),
        ),
      },
    });

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
        <StepNav hasItems={hasItems} onStep={setStep} step={step} />
        {step === "items" && (
          <ItemsStep
            choices={choices}
            {...(client === undefined ? {} : { client })}
            currency={currency}
            entries={entries}
            expenses={expenses}
            includedExpenseIds={includedExpenseIds}
            onChoice={(entry, change) =>
              setChoices((current) =>
                new Map(current).set(entry.id, {
                  ...entryChoice(current, entry),
                  ...change,
                }),
              )
            }
            onExpense={(expense, included) =>
              setIncludedExpenseIds((current) => {
                const next = new Set(current);
                if (included) {
                  next.add(expense.id);
                } else {
                  next.delete(expense.id);
                }
                return next;
              })
            }
            prefill={{ ...prefill, vat }}
          />
        )}
        {step === "details" && (
          <DetailsStep
            vat={vat}
            currency={currency}
            dueDate={dueDate}
            dueDays={dueDays}
            invoiceDate={invoiceDate}
            language={language}
            onDueDays={setDueDays}
            onInvoiceDate={setInvoiceDate}
            onLanguage={setLanguage}
            prefill={prefill}
            supplyDate={supplyDate}
          />
        )}
        {step === "issue" && (
          <IssueStep
            buyerName={prefill.buyer.buyerName}
            currency={currency}
            dueDate={dueDate}
            lineCount={includedEntryIds.length + includedExpenses.length}
            totals={totals}
          />
        )}
      </div>
      <ComposerFooter
        currency={currency}
        canSave={hasItems && vat.reason !== "no_vat_rate"}
        hasItems={hasItems}
        onSave={send}
        onStep={setStep}
        pending={submit.isPending}
        step={step}
        totals={totals}
      />
    </div>
  );
};

type CreateInvoiceBody = Parameters<ReturnType<typeof api.invoices>["put"]>[0];

/**
 * Creates the draft and, when asked, issues it. A refused issue keeps the
 * saved draft and says why, so nothing the person composed is lost; so
 * does an issue or read that fails after the draft was saved.
 */
const useComposerSubmit = ({
  workspaceId,
  client,
  onDone,
}: {
  workspaceId: string;
  client?: ClientComposer;
  onDone: (invoice: IssuedInvoice) => void;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      issue,
      body,
    }: {
      issue: boolean;
      body: CreateInvoiceBody;
    }): Promise<IssuedInvoice> => {
      const invoices = api.invoices({
        workspaceId: toSafeId<"workspace">(workspaceId),
      });
      return await submitComposedInvoice({
        issue,
        create: async () => {
          if (client === undefined) {
            return unwrapEden(
              await invokeCapability("invoices.create", async (request) =>
                invoices.put(body, request),
              ),
            );
          }
          return unwrapEden(
            await invokeCapability("client-invoices.create", async (request) =>
              api["client-invoices"]({
                clientId: toSafeId<"contact">(client.clientId),
              }).put(
                {
                  invoiceDate: body.invoiceDate,
                  ...(body.dueDate === undefined
                    ? {}
                    : { dueDate: body.dueDate }),
                  ...(body.taxableSupplyDate === undefined
                    ? {}
                    : { taxableSupplyDate: body.taxableSupplyDate }),
                  currency: body.currency,
                  ...(body.sellerProfileId === undefined
                    ? {}
                    : { sellerProfileId: body.sellerProfileId }),
                  ...(body.expectedTotalAmount === undefined
                    ? {}
                    : { expectedTotalAmount: body.expectedTotalAmount }),
                  matters: client.matters.flatMap((matter) => {
                    const timeEntryIds = matter.prefill.timeEntries
                      .filter((entry) =>
                        body.timeEntryIds.includes(
                          toSafeId<"timeEntry">(entry.id),
                        ),
                      )
                      .map((entry) => toSafeId<"timeEntry">(entry.id));
                    const expenseIds = matter.prefill.expenses
                      .filter((expense) =>
                        body.expenseIds?.includes(
                          toSafeId<"expense">(expense.id),
                        ),
                      )
                      .map((expense) => toSafeId<"expense">(expense.id));
                    return timeEntryIds.length + expenseIds.length === 0
                      ? []
                      : [
                          {
                            workspaceId: toSafeId<"workspace">(
                              matter.workspaceId,
                            ),
                            timeEntryIds,
                            expenseIds,
                          },
                        ];
                  }),
                },
                request,
              ),
            ),
          );
        },
        finalize: async (id) => {
          const finalized = await invokeCapability(
            "invoices.transition",
            async (request) =>
              invoices({
                invoiceId: toSafeId<"invoice">(id),
              }).transition.post({ action: "finalize" }, request),
          );
          if (finalized.error) {
            notifyUserError(
              finalized.error,
              t("billing.invoiceComposer.issueFailed"),
            );
          }
        },
        read: async (id): Promise<IssuedInvoice> => {
          const invoice = await queryClient.query(
            invoiceByIdOptions(workspaceId, id),
          );
          return {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            issued: invoice.status !== "draft",
            totalAmount: invoice.totalAmount,
            currency: invoice.currency,
            dueDate: invoice.dueDate,
          };
        },
        savedDraft: (created, error) => {
          notifyUserError(error, t("billing.invoiceComposer.issueFailed"));
          return {
            id: created.id,
            invoiceNumber: null,
            issued: false,
            totalAmount: created.totalAmount,
            currency: body.currency,
            dueDate: body.dueDate ?? null,
          };
        },
      });
    },
    onSuccess: (invoice) => {
      for (const queryKey of [
        ...(
          client?.matters.map((matter) => matter.workspaceId) ?? [workspaceId]
        ).flatMap((id) => [
          invoicesKeys.all(id),
          timeEntriesKeys.all(id),
          expensesQueryRoot(id),
        ]),
      ]) {
        detached(
          queryClient.invalidateQueries({ queryKey }),
          "invoice-composer.invalidate",
        );
      }
      onDone(invoice);
    },
    onError: (error) => {
      notifyUserError(error, t("billing.failedToSave"));
    },
  });
};

type StepNavProps = {
  step: ComposerStep;
  hasItems: boolean;
  onStep: (step: ComposerStep) => void;
};

const StepNav = ({ step, hasItems, onStep }: StepNavProps) => {
  const t = useTranslations();
  const current = COMPOSER_STEPS.indexOf(step);
  return (
    <ol className="flex flex-wrap gap-2">
      {COMPOSER_STEPS.map((candidate, index) => (
        <li key={candidate}>
          <Button
            aria-current={candidate === step ? "step" : undefined}
            disabled={index > current && !hasItems}
            onClick={() => onStep(candidate)}
            size="chip"
            variant={candidate === step ? "default" : "secondary"}
          >
            {index < current ? (
              <CheckIcon aria-hidden />
            ) : (
              <span aria-hidden className="tabular-nums">
                {index + 1}
              </span>
            )}
            {t(STEP_LABELS[candidate])}
          </Button>
        </li>
      ))}
    </ol>
  );
};

type ItemsStepProps = {
  client?: ClientComposer;
  adjustmentMode?: "editable" | "recorded";
  prefill: InvoicePrefill;
  currency: string;
  entries: readonly PrefillEntry[];
  expenses: readonly PrefillExpense[];
  choices: ReadonlyMap<string, EntryChoice>;
  includedExpenseIds: ReadonlySet<string>;
  onChoice: (entry: PrefillEntry, change: Partial<EntryChoice>) => void;
  onExpense: (expense: PrefillExpense, included: boolean) => void;
};

const ItemsStep = ({
  client,
  adjustmentMode = "editable",
  prefill,
  currency,
  entries,
  expenses,
  choices,
  includedExpenseIds,
  onChoice,
  onExpense,
}: ItemsStepProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const flatFee = prefill.billingMode === "flat_fee";
  if (client !== undefined) {
    const groups = client.matters.map((matter) => {
      const matterEntries = entries.filter((entry) =>
        matter.prefill.timeEntries.some((item) => item.id === entry.id),
      );
      const matterExpenses = expenses.filter((expense) =>
        matter.prefill.expenses.some((item) => item.id === expense.id),
      );
      const totals = composeTotals({
        entries: matterEntries,
        choices,
        expenses: matterExpenses,
        includedExpenseIds,
        vat: prefill.vat,
      });
      return {
        matter,
        matterEntries,
        matterExpenses,
        amount: totals?.grossAmountMinor ?? 0,
      };
    });
    const total = groups.reduce((sum, group) => sum + group.amount, 0);
    return (
      <div className="flex flex-col gap-4">
        <Callout>{t("billing.clientComposer.visibility")}</Callout>
        {groups.map(({ matter, matterEntries, matterExpenses, amount }) => {
          const allIncluded =
            matterEntries.every(
              (entry) => entryChoice(choices, entry).included,
            ) &&
            matterExpenses.every((expense) =>
              includedExpenseIds.has(expense.id),
            );
          return (
            <section className="flex flex-col gap-3" key={matter.workspaceId}>
              <div className="flex flex-wrap items-center gap-3">
                <Checkbox
                  aria-label={t("billing.clientComposer.includeMatter", {
                    matterName: matter.name,
                  })}
                  checked={allIncluded}
                  onCheckedChange={(included) => {
                    for (const entry of matterEntries) {
                      onChoice(entry, { included });
                    }
                    for (const expense of matterExpenses) {
                      onExpense(expense, included);
                    }
                  }}
                />
                <MatterIcon
                  className="size-5"
                  matter={{ id: matter.workspaceId, color: matter.color }}
                />
                <h2 className="min-w-0 flex-1 text-sm font-semibold">
                  <bdi>{matter.name}</bdi>
                </h2>
                <span className="text-sm font-medium tabular-nums">
                  {formatCurrencyAmount(amount, currency)}
                </span>
              </div>
              <meter
                aria-label={matter.name}
                className="h-2 w-full"
                value={total === 0 ? 0 : amount / total}
              />
              <ItemsStep
                adjustmentMode="recorded"
                prefill={matter.prefill}
                currency={currency}
                entries={matterEntries}
                expenses={matterExpenses}
                choices={choices}
                includedExpenseIds={includedExpenseIds}
                onChoice={onChoice}
                onExpense={onExpense}
              />
              <p className="text-muted-foreground text-end text-xs tabular-nums">
                {t("billing.clientComposer.matterSubtotal", {
                  amount: formatCurrencyAmount(amount, currency),
                  share: format.number(total === 0 ? 0 : amount / total, {
                    style: "percent",
                    maximumFractionDigits: 1,
                  }),
                })}
              </p>
            </section>
          );
        })}
      </div>
    );
  }
  const otherCurrencyCount =
    prefill.timeEntries.length -
    entries.length +
    (flatFee ? 0 : prefill.expenses.length - expenses.length);
  const includedCount = entries.filter(
    (entry) => entryChoice(choices, entry).included,
  ).length;
  return (
    <div className="flex flex-col gap-4">
      {flatFee && prefill.flatFeeAmount !== null && (
        <Frame>
          <FrameHeader>
            <FrameTitle>{t("billing.invoiceComposer.flatFeeLine")}</FrameTitle>
            <FrameDescription>
              {t("billing.invoiceComposer.flatFee", {
                amount: formatCurrencyAmount(prefill.flatFeeAmount, currency),
              })}
            </FrameDescription>
          </FrameHeader>
          <FramePanel className="flex items-center justify-between gap-4">
            <span>{t("billing.invoiceComposer.flatFeeLine")}</span>
            <span className="font-medium tabular-nums">
              {formatCurrencyAmount(prefill.flatFeeAmount, currency)}
            </span>
          </FramePanel>
        </Frame>
      )}
      {otherCurrencyCount > 0 && (
        <Callout>
          {t("billing.invoiceComposer.otherCurrency", {
            count: otherCurrencyCount,
            currency,
          })}
        </Callout>
      )}
      <Frame>
        <FrameHeader>
          <FrameTitle>{t("billing.invoiceComposer.timeEntries")}</FrameTitle>
          <FrameDescription>
            <span className="tabular-nums">
              {t("billing.invoiceComposer.timeSummary", {
                count: includedCount,
                hours: format.number(includedMinutes(entries, choices) / 60, {
                  maximumFractionDigits: 2,
                }),
              })}
            </span>
          </FrameDescription>
        </FrameHeader>
        {entries.length === 0 ? (
          <FramePanel>
            <p className="text-muted-foreground text-sm">
              {t("billing.invoiceComposer.noTime")}
            </p>
          </FramePanel>
        ) : (
          <TimeEntriesTable
            choices={choices}
            currency={currency}
            entries={entries}
            locked={flatFee || adjustmentMode === "recorded"}
            onChoice={onChoice}
          />
        )}
      </Frame>
      {!flatFee && (
        <Frame>
          <FrameHeader>
            <FrameTitle>{t("common.expenses")}</FrameTitle>
          </FrameHeader>
          {expenses.length === 0 ? (
            <FramePanel>
              <p className="text-muted-foreground text-sm">
                {t("billing.invoiceComposer.noExpenses")}
              </p>
            </FramePanel>
          ) : (
            <ExpensesTable
              currency={currency}
              expenses={expenses}
              includedExpenseIds={includedExpenseIds}
              onExpense={onExpense}
            />
          )}
        </Frame>
      )}
    </div>
  );
};

type TimeEntriesTableProps = {
  entries: readonly PrefillEntry[];
  choices: ReadonlyMap<string, EntryChoice>;
  currency: string;
  locked: boolean;
  onChoice: (entry: PrefillEntry, change: Partial<EntryChoice>) => void;
};

const TimeEntriesTable = ({
  entries,
  choices,
  currency,
  locked,
  onChoice,
}: TimeEntriesTableProps) => {
  const t = useTranslations();
  const format = useFormatter();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <span className="sr-only">
              {t("billing.invoiceComposer.include")}
            </span>
          </TableHead>
          <TableHead>{t("common.date")}</TableHead>
          <TableHead>{t("billing.narrative")}</TableHead>
          <TableHead className="text-end">
            {t("billing.invoiceComposer.billedHours")}
          </TableHead>
          <TableHead className="text-end">
            {t("billing.invoiceComposer.rate")}
          </TableHead>
          <TableHead className="text-end">{t("billing.amount")}</TableHead>
          <TableHead>{t("billing.invoiceComposer.noCharge")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => {
          const choice = entryChoice(choices, entry);
          const excluded = !choice.included;
          return (
            <TableRow key={entry.id}>
              <TableCell>
                <Checkbox
                  aria-label={t("billing.invoiceComposer.include")}
                  checked={choice.included}
                  onCheckedChange={(checked) =>
                    onChoice(entry, { included: checked })
                  }
                />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <RowText
                  className="text-muted-foreground tabular-nums"
                  excluded={excluded}
                >
                  {format.dateTime(
                    plainDateEpoch(entry.dateWorked),
                    SHORT_DATE,
                  )}
                </RowText>
              </TableCell>
              <TableCell className="min-w-0">
                <RowText className="line-clamp-2" excluded={excluded}>
                  {entry.invoiceNarrative ?? entry.narrative}
                </RowText>
                {entry.timekeeperName !== null && (
                  <span className="text-muted-foreground block text-xs">
                    {entry.timekeeperName}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-end">
                <BilledHoursInput
                  disabled={locked || excluded}
                  key={`${entry.id}:${choice.billedMinutes}`}
                  loggedMinutes={entry.durationMinutes}
                  minutes={choice.billedMinutes}
                  recordedMinutes={entry.billedMinutes}
                  onCommit={(billedMinutes) =>
                    onChoice(entry, { billedMinutes })
                  }
                />
              </TableCell>
              <TableCell className="text-end whitespace-nowrap">
                <RowText
                  className="text-muted-foreground tabular-nums"
                  excluded={excluded}
                >
                  {formatCurrencyAmount(entry.rateAtEntry, currency)}
                </RowText>
              </TableCell>
              <TableCell className="text-end whitespace-nowrap">
                <RowText
                  className={cn(
                    "font-medium tabular-nums",
                    choice.noCharge && "text-muted-foreground line-through",
                  )}
                  excluded={excluded}
                >
                  {formatCurrencyAmount(
                    entryAmount(entry, { ...choice, noCharge: false }),
                    currency,
                  )}
                </RowText>
              </TableCell>
              <TableCell>
                <Switch
                  aria-label={t("billing.invoiceComposer.noCharge")}
                  checked={choice.noCharge}
                  disabled={locked || excluded}
                  onCheckedChange={(noCharge) => onChoice(entry, { noCharge })}
                />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};

type ExpensesTableProps = {
  expenses: readonly PrefillExpense[];
  includedExpenseIds: ReadonlySet<string>;
  currency: string;
  onExpense: (expense: PrefillExpense, included: boolean) => void;
};

const ExpensesTable = ({
  expenses,
  includedExpenseIds,
  currency,
  onExpense,
}: ExpensesTableProps) => {
  const t = useTranslations();
  const format = useFormatter();
  return (
    <Table>
      <TableBody>
        {expenses.map((expense) => {
          const included = includedExpenseIds.has(expense.id);
          return (
            <TableRow key={expense.id}>
              <TableCell className="w-10">
                <Checkbox
                  aria-label={t("billing.invoiceComposer.include")}
                  checked={included}
                  onCheckedChange={(checked) => onExpense(expense, checked)}
                />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <RowText
                  className="text-muted-foreground tabular-nums"
                  excluded={!included}
                >
                  {format.dateTime(
                    plainDateEpoch(expense.dateIncurred),
                    SHORT_DATE,
                  )}
                </RowText>
              </TableCell>
              <TableCell className="min-w-0">
                <RowText className="line-clamp-2" excluded={!included}>
                  {expense.invoiceDescription ?? expense.description}
                </RowText>
              </TableCell>
              <TableCell className="text-end whitespace-nowrap">
                <RowText
                  className="font-medium tabular-nums"
                  excluded={!included}
                >
                  {formatCurrencyAmount(expenseAmount(expense), currency)}
                </RowText>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};

type DetailsStepProps = {
  prefill: InvoicePrefill;
  vat: ComposerVatDecision<InvoicePrefill["vat"]["reason"]>;
  currency: string;
  invoiceDate: string;
  supplyDate: string;
  dueDays: number;
  dueDate: string | null;
  language: InvoiceLanguage;
  onInvoiceDate: (date: string) => void;
  onDueDays: (days: number) => void;
  onLanguage: (language: InvoiceLanguage) => void;
};

const DetailsStep = ({
  prefill,
  vat,
  currency,
  invoiceDate,
  supplyDate,
  dueDays,
  dueDate,
  language,
  onInvoiceDate,
  onDueDays,
  onLanguage,
}: DetailsStepProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const locale = useLocale();
  const dueChoices = [
    ...new Set([...INVOICE_DUE_DAY_PRESETS, prefill.dueDays]),
  ].toSorted((left, right) => left - right);
  const { buyer, seller } = prefill;
  const buyerLines = [
    buyer.buyerAddressLine1,
    [buyer.buyerPostalCode, buyer.buyerCity]
      .filter((part) => part !== null)
      .join(" "),
    buyer.buyerVatId,
  ].filter((line): line is string => line !== null && line !== "");
  return (
    <div className="flex flex-col gap-4">
      <Frame>
        <FrameHeader>
          <FrameTitle>{t("workspaces.sections.parties")}</FrameTitle>
        </FrameHeader>
        <FramePanel>
          <DetailsGrid>
            <DetailsItem label={t("billing.invoiceComposer.seller")}>
              {seller === null ? (
                <Link
                  className="underline underline-offset-4"
                  to="/admin/billing"
                >
                  {t("billing.invoiceComposer.addSellerProfile")}
                </Link>
              ) : (
                <span className="flex flex-col">
                  <span>{seller.legalName}</span>
                  <SourceHint>
                    {t("billing.invoiceComposer.sources.defaultSeller")}
                  </SourceHint>
                </span>
              )}
            </DetailsItem>
            <DetailsItem label={t("billing.invoiceComposer.buyer")}>
              {buyer.buyerName === null ? (
                <SourceHint>{t("billing.invoiceComposer.noClient")}</SourceHint>
              ) : (
                <span className="flex flex-col">
                  <span>{buyer.buyerName}</span>
                  {buyerLines.map((line) => (
                    <bdi key={line}>{line}</bdi>
                  ))}
                  <SourceHint>
                    {t("billing.invoiceComposer.sources.client")}
                  </SourceHint>
                </span>
              )}
            </DetailsItem>
          </DetailsGrid>
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader>
          <FrameTitle>
            {t("billing.invoiceComposer.datesAndPayment")}
          </FrameTitle>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                {t("billing.invoices.invoiceDate")}
              </span>
              <DatePickerPopover
                onChange={(value) =>
                  onInvoiceDate(value ?? prefill.invoiceDate)
                }
                value={invoiceDate}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                {t("billing.invoiceComposer.taxableSupplyDate")}
              </span>
              <span className="text-sm tabular-nums">
                {format.dateTime(plainDateEpoch(supplyDate), MEDIUM_DATE)}
              </span>
              <SourceHint>
                {t("billing.invoiceComposer.sources.lastWorkDay")}
              </SourceHint>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium" id="invoice-due-in">
              {t("billing.invoiceComposer.dueIn")}
            </span>
            <div
              aria-labelledby="invoice-due-in"
              className="flex flex-wrap items-center gap-2"
              role="group"
            >
              {dueChoices.map((days) => (
                <Button
                  aria-pressed={days === dueDays}
                  key={days}
                  onClick={() => onDueDays(days)}
                  size="chip"
                  variant={days === dueDays ? "default" : "outline"}
                >
                  {t("billing.invoiceComposer.days", { days })}
                </Button>
              ))}
              {dueDate !== null && (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {format.dateTime(plainDateEpoch(dueDate), MEDIUM_DATE)}
                </span>
              )}
            </div>
            <SourceHint>
              {t(
                prefill.dueDaysSource === "client"
                  ? "billing.invoiceComposer.sources.clientTerm"
                  : "billing.invoiceComposer.sources.defaultTerm",
              )}
            </SourceHint>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t("common.language")}</span>
            <Select
              onValueChange={(value) => {
                if (isInvoiceLanguage(value)) {
                  onLanguage(value);
                }
              }}
              value={language}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {INVOICE_LANGUAGES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {displayLanguageName(value, { displayLocale: locale })}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader>
          <FrameTitle>{t("billing.invoiceComposer.tax")}</FrameTitle>
        </FrameHeader>
        <FramePanel>
          <DetailsGrid>
            <DetailsItem label={t("billing.invoiceComposer.vat")}>
              <span className="flex flex-col">
                <span>
                  {vat.vatTreatment === "domestic_vat"
                    ? t("billing.invoiceComposer.vatRate", {
                        rate: format.number(vat.vatRateBps / 100, {
                          maximumFractionDigits: 2,
                        }),
                      })
                    : t(VAT_TREATMENT_LABELS[vat.vatTreatment])}
                </span>
                <SourceHint>{t(VAT_REASON_LABELS[vat.reason])}</SourceHint>
              </span>
            </DetailsItem>
            <DetailsItem label={t("common.currency")}>{currency}</DetailsItem>
          </DetailsGrid>
        </FramePanel>
      </Frame>
    </div>
  );
};

type IssueStepProps = {
  buyerName: string | null;
  currency: string;
  dueDate: string | null;
  lineCount: number;
  totals: InvoiceTotals | null;
};

const IssueStep = ({
  buyerName,
  currency,
  dueDate,
  lineCount,
  totals,
}: IssueStepProps) => {
  const t = useTranslations();
  const format = useFormatter();
  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>{t("billing.invoiceComposer.readyTitle")}</FrameTitle>
        <FrameDescription>
          {t("billing.invoiceComposer.readyDescription")}
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <DetailsGrid>
          <DetailsItem label={t("billing.invoiceComposer.buyer")}>
            {buyerName ?? "—"}
          </DetailsItem>
          <DetailsItem label={t("billing.invoiceComposer.lines")}>
            <span className="tabular-nums">{format.number(lineCount)}</span>
          </DetailsItem>
          <DetailsItem label={t("billing.invoices.dueDate")}>
            {dueDate === null
              ? "—"
              : format.dateTime(plainDateEpoch(dueDate), MEDIUM_DATE)}
          </DetailsItem>
          <DetailsItem label={t("billing.invoices.totalAmount")}>
            <span className="font-medium tabular-nums">
              {totals === null
                ? "—"
                : formatCurrencyAmount(totals.grossAmountMinor, currency)}
            </span>
          </DetailsItem>
        </DetailsGrid>
      </FramePanel>
    </Frame>
  );
};

type ComposerFooterProps = {
  step: ComposerStep;
  totals: InvoiceTotals | null;
  currency: string;
  hasItems: boolean;
  /** False while nothing is billable or no VAT rate is in force. */
  canSave: boolean;
  pending: boolean;
  onStep: (step: ComposerStep) => void;
  onSave: (issue: boolean) => void;
};

const ComposerFooter = ({
  step,
  totals,
  currency,
  hasItems,
  canSave,
  pending,
  onStep,
  onSave,
}: ComposerFooterProps) => {
  const t = useTranslations();
  const index = COMPOSER_STEPS.indexOf(step);
  const previous = COMPOSER_STEPS[index - 1];
  const next = COMPOSER_STEPS[index + 1];
  return (
    <div className="bg-background sticky bottom-0 flex flex-wrap items-center gap-3 border-t px-4 py-3 sm:px-6">
      <span className="text-muted-foreground text-sm tabular-nums">
        {totals !== null &&
          t("billing.invoiceComposer.totalsSummary", {
            net: formatCurrencyAmount(totals.netAmountMinor, currency),
            vat: formatCurrencyAmount(totals.vatAmountMinor, currency),
            total: formatCurrencyAmount(totals.grossAmountMinor, currency),
          })}
      </span>
      <span className="flex-1" />
      {previous !== undefined && (
        <Button
          disabled={pending}
          onClick={() => onStep(previous)}
          variant="ghost"
        >
          <DirectionalIcon className="size-4" icon={ArrowLeftIcon} />
          {t("common.back")}
        </Button>
      )}
      {next === undefined ? (
        <>
          <Button
            disabled={!canSave || pending}
            onClick={() => onSave(false)}
            variant="outline"
          >
            {t("billing.invoiceComposer.saveDraft")}
          </Button>
          <Button disabled={!canSave || pending} onClick={() => onSave(true)}>
            {t("billing.invoiceComposer.issueInvoice")}
          </Button>
        </>
      ) : (
        <Button disabled={!hasItems} onClick={() => onStep(next)}>
          {t(
            next === "details"
              ? "billing.invoiceComposer.continueToDetails"
              : "billing.invoiceComposer.continueToIssue",
          )}
          <DirectionalIcon className="size-4" icon={ArrowRightIcon} />
        </Button>
      )}
    </div>
  );
};

type BilledHoursInputProps = {
  minutes: number;
  /** What the entry bills as recorded; the logged time shows once it changes. */
  recordedMinutes: number;
  loggedMinutes: number;
  disabled: boolean;
  onCommit: (minutes: number) => void;
};

/**
 * Hours as the person types them; parsed into minutes when they leave the
 * field. Text that is not a number of hours reverts to the last value.
 */
const BilledHoursInput = ({
  minutes,
  recordedMinutes,
  loggedMinutes,
  disabled,
  onCommit,
}: BilledHoursInputProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const shown = editableHoursText(minutes, useLocale());
  const [text, setText] = useState(shown);
  return (
    <span className="flex flex-col items-end gap-0.5">
      <Input
        aria-label={t("billing.invoiceComposer.billedHours")}
        className="w-20"
        dir="ltr"
        disabled={disabled}
        inputMode="decimal"
        onBlur={() => {
          const parsed = parseHoursInput(text);
          if (parsed === null) {
            setText(shown);
            return;
          }
          onCommit(parsed);
        }}
        onChange={(event) => setText(event.target.value)}
        size="sm"
        value={text}
      />
      {minutes !== recordedMinutes && (
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("billing.invoiceComposer.loggedHours", {
            hours: format.number(loggedMinutes / 60, {
              maximumFractionDigits: 2,
            }),
          })}
        </span>
      )}
    </span>
  );
};

type IssuedStateProps = {
  workspaceId: string;
  invoice: IssuedInvoice;
  buyerName: string | null;
};

const IssuedState = ({ workspaceId, invoice, buyerName }: IssuedStateProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const summary = [
    buyerName,
    formatCurrencyAmount(invoice.totalAmount, invoice.currency),
    invoice.dueDate === null
      ? null
      : t("billing.invoiceComposer.dueOn", {
          date: format.dateTime(plainDateEpoch(invoice.dueDate), MEDIUM_DATE),
        }),
  ].filter((part) => part !== null);
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
      <span className="bg-muted flex size-14 items-center justify-center rounded-full">
        <CircleCheckIcon aria-hidden className="size-7" />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-balance">
          {invoice.issued && invoice.invoiceNumber !== null
            ? t("billing.invoiceComposer.issuedTitle", {
                number: invoice.invoiceNumber,
              })
            : t("billing.invoiceComposer.draftSavedTitle")}
        </h2>
        <p className="text-muted-foreground text-sm tabular-nums">
          {summary.join(" · ")}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <InvoicePdfDownloadButton
          invoiceId={invoice.id}
          workspaceId={workspaceId}
        />
        <Link
          params={{ workspaceId, invoiceId: invoice.id }}
          to="/workspaces/$workspaceId/invoices/$invoiceId"
        >
          <Button>{t("billing.invoiceComposer.openInvoice")}</Button>
        </Link>
      </div>
    </div>
  );
};
