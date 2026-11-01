import entry0 from "./caseLaw.backfillProvisionState.minutely";
import entry1 from "./caseLaw.backfillRedactionTombstones.v3";
import entry2 from "./caseLaw.refreshCoverage.fiveMinute";
import entry3 from "./caseLaw.refreshSitemapShards.hourly";
import entry4 from "./caseLaw.reportFreshness.fiveMinute";
import entry5 from "./legislation.backfillExpressionIds.fiveMinute";
import entry6 from "./requests.sweepReceipts.hourly";

export default {
  "caseLaw.backfillProvisionState.minutely": entry0,
  "caseLaw.backfillRedactionTombstones.v3": entry1,
  "caseLaw.refreshCoverage.fiveMinute": entry2,
  "caseLaw.refreshSitemapShards.hourly": entry3,
  "caseLaw.reportFreshness.fiveMinute": entry4,
  "legislation.backfillExpressionIds.fiveMinute": entry5,
  "requests.sweepReceipts.hourly": entry6,
} as const;
