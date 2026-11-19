import { createContext, use } from "react";
import type { PropsWithChildren } from "react";

import { useTranslations } from "use-intl";
import { createFormatter, type DateTimeFormatOptions } from "use-intl/core";

import { parsePlainDate } from "@stll/time";
import { FaceLabelPending } from "@stll/ui/control-face";
import { InlineSkeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

// Whether the app's intl is mounted above. A pending view also renders where
// it is not (the server's cold-load paint, the locale gate), so it may not
// call `useTranslations` itself.
const PendingIntlContext = createContext<
  ReturnType<typeof createFormatter> | undefined
>(undefined);

/**
 * Whether the app's intl is mounted above, for a label `PendingText` cannot
 * name (a frame's nav label): render its text only then.
 */
export const useIntlMounted = (): boolean =>
  use(PendingIntlContext) !== undefined;

/** Marks the subtree where the app's intl provider has its messages. */
export const PendingTextIntlScope = ({
  children,
  formattingLocale,
}: PropsWithChildren<{ formattingLocale: string }>) => {
  const formatter = createFormatter({
    locale: formattingLocale,
    timeZone: "UTC",
  });
  return <PendingIntlContext value={formatter}>{children}</PendingIntlContext>;
};

// The static labels pending views show. A closed union keeps the
// translator's key type small (`t` checks each one is a real message); a
// page adds its labels here as it gains a pending view.
type PendingTextKey =
  | "admin.toolsDescription"
  | "auth.continueWithEmail"
  | "auth.emailPlaceholder"
  | "auth.error.generic"
  | "auth.error.providerUnavailable"
  | "auth.error.title"
  | "auth.handoffTitle"
  | "auth.headline"
  | "auth.invitation.title"
  | "auth.professionalUse.title"
  | "auth.professionalUseStatement"
  | "auth.reauthenticationRequired"
  | "auth.signIn"
  | "auth.signInBeforeInvitation"
  | "auth.subtitle"
  | "auth.twoFactor.enterAuthenticatorCode"
  | "auth.twoFactor.title"
  | "auth.twoFactor.useBackupCode"
  | "auth.useDifferentEmail"
  | "bilingualTranslate.rows.title"
  | "billing.addEntry"
  | "billing.amount"
  | "billing.approval.everyone"
  | "billing.approval.myTime"
  | "billing.approval.returnComment"
  | "billing.approval.timeEntries"
  | "billing.approval.title"
  | "billing.approve"
  | "billing.codes.manageCodes"
  | "billing.hours"
  | "billing.invoiceComposer.billedHours"
  | "billing.invoiceComposer.continueToDetails"
  | "billing.invoiceComposer.include"
  | "billing.invoiceComposer.noCharge"
  | "billing.invoiceComposer.rate"
  | "billing.invoiceComposer.steps.issue"
  | "billing.invoiceComposer.steps.items"
  | "billing.invoiceComposer.timeEntries"
  | "billing.invoiceComposer.title"
  | "billing.invoices.createInvoice"
  | "billing.invoices.dueDate"
  | "billing.invoices.invoiceDate"
  | "billing.invoices.invoiceDetail"
  | "billing.invoices.invoiceNumber"
  | "billing.invoices.linkedTimeEntries"
  | "billing.invoices.totalAmount"
  | "billing.narrative"
  | "billing.numberSeries.add"
  | "billing.numberSeries.description"
  | "billing.numberSeries.documentType"
  | "billing.numberSeries.issueDate"
  | "billing.numberSeries.name"
  | "billing.numberSeries.pattern"
  | "billing.numberSeries.preview"
  | "billing.numberSeries.previewHelp"
  | "billing.numberSeries.title"
  | "billing.rates.rates"
  | "billing.revertToDraft"
  | "billing.sellerProfiles.add"
  | "billing.sellerProfiles.defaultCurrency"
  | "billing.sellerProfiles.description"
  | "billing.sellerProfiles.legalName"
  | "billing.sellerProfiles.title"
  | "billing.settingsTitle"
  | "billing.timeReport.billableHours"
  | "billing.timeReport.billableShare"
  | "billing.timeReport.pendingEntries"
  | "billing.timeReport.privacy"
  | "billing.timeReport.title"
  | "billing.timeReport.total"
  | "billing.timesheets"
  | "billing.vatRates.add"
  | "billing.vatRates.addCzechia"
  | "billing.vatRates.addSlovakia"
  | "billing.vatRates.code"
  | "billing.vatRates.description"
  | "billing.vatRates.name"
  | "billing.vatRates.rate"
  | "billing.vatRates.title"
  | "billing.vatRates.validFrom"
  | "billing.vatRates.validTo"
  | "chat.composerMenu.context"
  | "chat.greeting"
  | "chat.landing.recentChats"
  | "chat.landing.skills"
  | "chat.newChat"
  | "chat.placeholder"
  | "clauses.export"
  | "common.accept"
  | "common.action"
  | "common.actions"
  | "common.add"
  | "common.anonymizationLabels.person"
  | "common.back"
  | "common.cancel"
  | "common.category"
  | "common.columns"
  | "common.confirm"
  | "common.date"
  | "common.decline"
  | "common.description"
  | "common.details"
  | "common.email"
  | "common.expenses"
  | "common.history"
  | "common.invite"
  | "common.invoices"
  | "common.logTime"
  | "common.matter"
  | "common.members"
  | "common.name"
  | "common.next"
  | "common.previous"
  | "common.reference"
  | "common.role"
  | "common.search"
  | "common.selectAMatter"
  | "common.selectDate"
  | "common.showDetails"
  | "common.signOut"
  | "common.start"
  | "common.status"
  | "common.today"
  | "common.tryAgain"
  | "common.user"
  | "common.verify"
  | "common.workflows"
  | "flows.runs.history"
  | "flows.runs.launch"
  | "flows.runs.selectFlow"
  | "folio.listsGroup"
  | "guidance.notCaseLaw"
  | "inspector.matterPicker.allMatters"
  | "knowledge.sections.tools.title"
  | "lawHome.prompt"
  | "lawHome.recent"
  | "lawHome.signals"
  | "lawHome.topCourts"
  | "organization.invitations.expires"
  | "organization.invitations.invited"
  | "organization.members.joined"
  | "organization.roles.member"
  | "search.dateFrom"
  | "search.dateTo"
  | "search.kinds.task"
  | "search.timeFilterCustom"
  | "settings.organization.activeMembers"
  | "settings.organization.auditLogs"
  | "settings.organization.auditLogsAllActions"
  | "settings.organization.auditLogsChanges"
  | "settings.organization.auditLogsDescription"
  | "settings.organization.auditLogsExport"
  | "settings.organization.auditLogsFrom"
  | "settings.organization.auditLogsPerformer"
  | "settings.organization.auditLogsPerformerPeople"
  | "settings.organization.auditLogsPersonPlaceholder"
  | "settings.organization.auditLogsResourceType"
  | "settings.organization.auditLogsResourceTypePlaceholder"
  | "settings.organization.auditLogsTime"
  | "settings.organization.auditLogsTo"
  | "settings.organization.documentTypes.addPlaceholder"
  | "settings.organization.documentTypes.description"
  | "settings.organization.documentTypes.title"
  | "settings.organization.membersDescription"
  | "settings.organization.pendingInvitations"
  | "settings.organization.usage"
  | "settings.organization.usageDescription"
  | "settings.organization.usageManage"
  | "settings.organization.usagePacksDescription"
  | "settings.organization.usagePacksTitle"
  | "settings.organization.usagePlanCheckout"
  | "settings.organization.usagePlansDescription"
  | "settings.organization.usagePlansTitle"
  | "settings.organization.usageUnitsThisPeriod"
  | "tasks.dueDate"
  | "tasks.priority"
  | "tasks.status"
  | "templates.addItem"
  | "timesheets.week.title"
  | "workspaces.parties.client"
  | "workspaces.views.calendar.month"
  | "workspaces.views.calendar.week"
  | "workspaces.views.exportCsv"
  | "workspaces.views.reportExport.title"
  | "workspaces.views.timeline.day";

const TranslatedText = ({ id }: { id: PendingTextKey }) => {
  const t = useTranslations();
  return t(id);
};

/**
 * A static label in a pending view: the translated message where the app's
 * intl is mounted, and a bar on the label's own line where it is not yet, so
 * the label never moves when the text arrives.
 */
export const PendingText = ({
  barClassName = "w-24",
  id,
}: {
  /** The bar's width, roughly the label's. */
  barClassName?: string | undefined;
  id: PendingTextKey;
}) =>
  useIntlMounted() ? (
    <TranslatedText id={id} />
  ) : (
    // One line box of the surrounding text, so the bar keeps the label's
    // height inside a flex row as well as in running text. Top-aligned: on
    // the baseline, an inline box with no text of its own adds a descent and
    // grows the line by a pixel.
    <span
      aria-hidden="true"
      className="inline-flex h-[1lh] items-center align-top"
    >
      <InlineSkeleton className={cn("h-[0.75em]", barClassName)} />
    </span>
  );

const PENDING_SHORT_DATE = {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
} as const satisfies Intl.DateTimeFormatOptions;

export const PendingDate = ({
  date,
  options = PENDING_SHORT_DATE,
}: {
  date?: string | undefined;
  options?: DateTimeFormatOptions;
}) => {
  const formatter = use(PendingIntlContext);
  const plainDate = date === undefined ? null : parsePlainDate(date);
  return formatter !== undefined && plainDate !== null ? (
    formatter.dateTime(
      plainDate.toZonedDateTime("UTC").epochMilliseconds,
      options,
    )
  ) : (
    <FaceLabelPending className="w-10" />
  );
};
