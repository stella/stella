import entry0 from "./caseLaw.refreshCoverage.fiveMinute";
import entry1 from "./caseLaw.refreshSitemapShards.hourly";
import entry2 from "./caseLaw.reportFreshness.fiveMinute";
import entry3 from "./onlineWork.runPending.minutely";
import entry4 from "./requests.sweepReceipts.hourly";

export default {
  "caseLaw.refreshCoverage.fiveMinute": entry0,
  "caseLaw.refreshSitemapShards.hourly": entry1,
  "caseLaw.reportFreshness.fiveMinute": entry2,
  "onlineWork.runPending.minutely": entry3,
  "requests.sweepReceipts.hourly": entry4,
} as const;
