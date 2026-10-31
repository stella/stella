import entry0 from "./caseLaw.backfillRedactionTombstones.v3";
import entry1 from "./caseLaw.refreshCoverage.fiveMinute";
import entry2 from "./caseLaw.refreshSitemapShards.hourly";
import entry3 from "./caseLaw.reportFreshness.fiveMinute";
import entry4 from "./requests.sweepReceipts.hourly";

export default {
  "caseLaw.backfillRedactionTombstones.v3": entry0,
  "caseLaw.refreshCoverage.fiveMinute": entry1,
  "caseLaw.refreshSitemapShards.hourly": entry2,
  "caseLaw.reportFreshness.fiveMinute": entry3,
  "requests.sweepReceipts.hourly": entry4,
} as const;
