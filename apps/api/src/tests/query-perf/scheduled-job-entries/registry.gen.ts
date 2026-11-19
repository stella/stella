import entry0 from "./caseLaw.backfillProvisionState.minutely";
import entry1 from "./caseLaw.refreshCoverage.fiveMinute";
import entry2 from "./caseLaw.refreshSitemapShards.hourly";
import entry3 from "./caseLaw.reportFreshness.fiveMinute";
import entry4 from "./chat.sendLimitReminders.minute";
import entry5 from "./chat.sweepCommandReceipts.tenMinute";
import entry6 from "./dataExports.maintain.fiveMinute";
import entry7 from "./legislation.backfillExpressionIds.fiveMinute";
import entry8 from "./requests.sweepReceipts.hourly";
import entry9 from "./softLaw.sync.daily";
import entry10 from "./usage.eraseHostedCustomers.minute";

export default {
  "caseLaw.backfillProvisionState.minutely": entry0,
  "caseLaw.refreshCoverage.fiveMinute": entry1,
  "caseLaw.refreshSitemapShards.hourly": entry2,
  "caseLaw.reportFreshness.fiveMinute": entry3,
  "chat.sendLimitReminders.minute": entry4,
  "chat.sweepCommandReceipts.tenMinute": entry5,
  "dataExports.maintain.fiveMinute": entry6,
  "legislation.backfillExpressionIds.fiveMinute": entry7,
  "requests.sweepReceipts.hourly": entry8,
  "softLaw.sync.daily": entry9,
  "usage.eraseHostedCustomers.minute": entry10,
} as const;
