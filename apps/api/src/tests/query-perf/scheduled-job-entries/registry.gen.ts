import entry0 from "./caseLaw.backfillProvisionState.minutely";
import entry1 from "./caseLaw.refreshCoverage.fiveMinute";
import entry2 from "./caseLaw.refreshSitemapShards.hourly";
import entry3 from "./caseLaw.reportFreshness.fiveMinute";
import entry4 from "./legislation.backfillExpressionIds.fiveMinute";
import entry5 from "./onlineWork.runPending.minutely";
import entry6 from "./requests.sweepReceipts.hourly";

export default {
  "caseLaw.backfillProvisionState.minutely": entry0,
  "caseLaw.refreshCoverage.fiveMinute": entry1,
  "caseLaw.refreshSitemapShards.hourly": entry2,
  "caseLaw.reportFreshness.fiveMinute": entry3,
  "legislation.backfillExpressionIds.fiveMinute": entry4,
  "onlineWork.runPending.minutely": entry5,
  "requests.sweepReceipts.hourly": entry6,
} as const;
