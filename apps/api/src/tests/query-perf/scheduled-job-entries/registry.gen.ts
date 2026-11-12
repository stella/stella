import entry0 from "./caseLaw.backfillProvisionState.minutely";
import entry1 from "./caseLaw.refreshCoverage.fiveMinute";
import entry2 from "./caseLaw.refreshSitemapShards.hourly";
import entry3 from "./caseLaw.reportFreshness.fiveMinute";
import entry4 from "./dataExports.maintain.fiveMinute";
import entry5 from "./legislation.backfillExpressionIds.fiveMinute";
import entry6 from "./requests.sweepReceipts.hourly";
import entry7 from "./usage.eraseHostedCustomers.minute";

export default {
  "caseLaw.backfillProvisionState.minutely": entry0,
  "caseLaw.refreshCoverage.fiveMinute": entry1,
  "caseLaw.refreshSitemapShards.hourly": entry2,
  "caseLaw.reportFreshness.fiveMinute": entry3,
  "dataExports.maintain.fiveMinute": entry4,
  "legislation.backfillExpressionIds.fiveMinute": entry5,
  "requests.sweepReceipts.hourly": entry6,
  "usage.eraseHostedCustomers.minute": entry7,
} as const;
