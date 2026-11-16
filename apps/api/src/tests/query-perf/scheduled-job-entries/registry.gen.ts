import entry0 from "./caseLaw.backfillProvisionState.minutely";
import entry1 from "./caseLaw.refreshCoverage.fiveMinute";
import entry2 from "./caseLaw.refreshSitemapShards.hourly";
import entry3 from "./caseLaw.reportFreshness.fiveMinute";
import entry4 from "./chat.sendLimitReminders.minute";
import entry5 from "./dataExports.maintain.fiveMinute";
import entry6 from "./legislation.backfillExpressionIds.fiveMinute";
import entry7 from "./requests.sweepReceipts.hourly";
import entry8 from "./usage.eraseHostedCustomers.minute";

export default {
  "caseLaw.backfillProvisionState.minutely": entry0,
  "caseLaw.refreshCoverage.fiveMinute": entry1,
  "caseLaw.refreshSitemapShards.hourly": entry2,
  "caseLaw.reportFreshness.fiveMinute": entry3,
  "chat.sendLimitReminders.minute": entry4,
  "dataExports.maintain.fiveMinute": entry5,
  "legislation.backfillExpressionIds.fiveMinute": entry6,
  "requests.sweepReceipts.hourly": entry7,
  "usage.eraseHostedCustomers.minute": entry8,
} as const;
