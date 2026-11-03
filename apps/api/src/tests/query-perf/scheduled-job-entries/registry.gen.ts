import entry0 from "./caseLaw.backfillProvisionState.minutely";
import entry1 from "./caseLaw.refreshCoverage.fiveMinute";
import entry2 from "./caseLaw.refreshSitemapShards.hourly";
import entry3 from "./caseLaw.reportFreshness.fiveMinute";
import entry4 from "./legislation.backfillExpressionIds.fiveMinute";
import entry5 from "./requests.sweepReceipts.hourly";
import entry6 from "./usage.eraseHostedCustomers.minute";

export default {
  "caseLaw.backfillProvisionState.minutely": entry0,
  "caseLaw.refreshCoverage.fiveMinute": entry1,
  "caseLaw.refreshSitemapShards.hourly": entry2,
  "caseLaw.reportFreshness.fiveMinute": entry3,
  "legislation.backfillExpressionIds.fiveMinute": entry4,
  "requests.sweepReceipts.hourly": entry5,
  "usage.eraseHostedCustomers.minute": entry6,
} as const;
