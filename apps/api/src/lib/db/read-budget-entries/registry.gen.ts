import entry0 from "./scheduled.caseLaw.refreshCoverage";
import entry1 from "./scheduled.caseLaw.refreshSitemapShards";
import entry2 from "./scheduled.caseLaw.reportFreshness";
import entry3 from "./scheduled.requests.sweepReceipts";
import entry4 from "./statement.caseLaw.backgroundReplayProbe";
import entry5 from "./statement.caseLaw.coverageSources";
import entry6 from "./statement.caseLaw.euCompletionPage";
import entry7 from "./statement.caseLaw.globalSearchHits";
import entry8 from "./statement.documents.searchHits";
import entry9 from "./statement.legislation.candidateRows";

export default {
  "scheduled.caseLaw.refreshCoverage": entry0,
  "scheduled.caseLaw.refreshSitemapShards": entry1,
  "scheduled.caseLaw.reportFreshness": entry2,
  "scheduled.requests.sweepReceipts": entry3,
  "statement.caseLaw.backgroundReplayProbe": entry4,
  "statement.caseLaw.coverageSources": entry5,
  "statement.caseLaw.euCompletionPage": entry6,
  "statement.caseLaw.globalSearchHits": entry7,
  "statement.documents.searchHits": entry8,
  "statement.legislation.candidateRows": entry9,
} as const;
