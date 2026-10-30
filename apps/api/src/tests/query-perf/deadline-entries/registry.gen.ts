import entry0 from "./scheduled.caseLaw.refreshSitemapShards";
import entry1 from "./scheduled.caseLaw.reportFreshness";
import entry2 from "./scheduled.requests.sweepReceipts";
import entry3 from "./statement.caseLaw.coverageSources";
import entry4 from "./statement.caseLaw.globalSearchHits";
import entry5 from "./statement.documents.searchHits";
import entry6 from "./statement.legislation.candidateRows";

export default {
  "scheduled.caseLaw.refreshSitemapShards": entry0,
  "scheduled.caseLaw.reportFreshness": entry1,
  "scheduled.requests.sweepReceipts": entry2,
  "statement.caseLaw.coverageSources": entry3,
  "statement.caseLaw.globalSearchHits": entry4,
  "statement.documents.searchHits": entry5,
  "statement.legislation.candidateRows": entry6,
} as const;
