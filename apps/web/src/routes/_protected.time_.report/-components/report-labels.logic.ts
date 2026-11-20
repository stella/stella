import type {
  TimeEntryReportBucket,
  TimeEntryReportGroupBy,
} from "@stll/api-contract/time-entry-report";

import type { TranslationKey } from "@/i18n/types";

import type { ReportPeriod } from "./report.logic";

const REPORT_AXIS_LABELS = {
  week: "workspaces.views.calendar.week",
  month: "workspaces.views.calendar.month",
  custom: "search.timeFilterCustom",
  day: "workspaces.views.timeline.day",
  member: "organization.roles.member",
  matter: "common.matter",
  client: "workspaces.parties.client",
} as const satisfies Record<
  ReportPeriod | TimeEntryReportBucket | TimeEntryReportGroupBy,
  TranslationKey
>;

export const REPORT_LABELS = {
  title: "billing.timeReport.title",
  period: "billing.timeReport.period",
  ...REPORT_AXIS_LABELS,
  rows: "bilingualTranslate.rows.title",
  columns: "common.columns",
  from: "search.dateFrom",
  to: "search.dateTo",
  total: "billing.timeReport.total",
  billableHours: "billing.timeReport.billableHours",
  billableShare: "billing.timeReport.billableShare",
  pendingEntries: "billing.timeReport.pendingEntries",
  unbilledValue: "billing.timeReport.unbilledValue",
  activeMembers: "settings.organization.activeMembers",
  change: "billing.timeReport.change",
  changePoints: "billing.timeReport.changePoints",
  privacy: "billing.timeReport.privacy",
  empty: "billing.timeReport.empty",
  tooManyCells: "billing.timeReport.tooManyCells",
  tooLargeToLoad: "billing.timeReport.tooLargeToLoad",
  unassigned: "common.unassigned",
  internal: "billing.timeReport.internal",
  exportCsv: "workspaces.views.exportCsv",
  expand: "billing.timeReport.expand",
  collapse: "billing.timeReport.collapse",
} as const;
