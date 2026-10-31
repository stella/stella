import entry0 from "./scheduled.caseLaw.refreshCoverage";
import entry1 from "./scheduled.caseLaw.refreshSitemapShards";
import entry2 from "./scheduled.caseLaw.reportFreshness";
import entry3 from "./scheduled.requests.sweepReceipts";
import entry4 from "./statement.caseLaw.coverageSources";
import entry5 from "./statement.caseLaw.euCompletionPage";
import entry6 from "./statement.caseLaw.globalSearchHits";
import entry7 from "./statement.documents.searchHits";
import entry8 from "./statement.legislation.candidateRows";

export default {
  "scheduled.caseLaw.refreshCoverage": entry0,
  "scheduled.caseLaw.refreshSitemapShards": entry1,
  "scheduled.caseLaw.reportFreshness": entry2,
  "scheduled.requests.sweepReceipts": entry3,
  "statement.caseLaw.coverageSources": entry4,
  "statement.caseLaw.euCompletionPage": entry5,
  "statement.caseLaw.globalSearchHits": entry6,
  "statement.documents.searchHits": entry7,
  "statement.legislation.candidateRows": entry8,
} as const;
