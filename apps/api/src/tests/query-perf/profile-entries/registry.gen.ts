import entry0 from "./scheduled.caseLaw.backfillProvisionState";
import entry1 from "./scheduled.caseLaw.refreshCoverage";
import entry2 from "./scheduled.caseLaw.refreshSitemapShards";
import entry3 from "./scheduled.caseLaw.reportFreshness";
import entry4 from "./scheduled.legislation.backfillExpressionIds";
import entry5 from "./scheduled.onlineWork.runPending";
import entry6 from "./scheduled.requests.sweepReceipts";
import entry7 from "./statement.caseLaw.coverageSources";
import entry8 from "./statement.caseLaw.euCompletionPage";
import entry9 from "./statement.caseLaw.globalSearchHits";
import entry10 from "./statement.documents.searchHits";
import entry11 from "./statement.legislation.candidateRows";

export default {
  "scheduled.caseLaw.backfillProvisionState": entry0,
  "scheduled.caseLaw.refreshCoverage": entry1,
  "scheduled.caseLaw.refreshSitemapShards": entry2,
  "scheduled.caseLaw.reportFreshness": entry3,
  "scheduled.legislation.backfillExpressionIds": entry4,
  "scheduled.onlineWork.runPending": entry5,
  "scheduled.requests.sweepReceipts": entry6,
  "statement.caseLaw.coverageSources": entry7,
  "statement.caseLaw.euCompletionPage": entry8,
  "statement.caseLaw.globalSearchHits": entry9,
  "statement.documents.searchHits": entry10,
  "statement.legislation.candidateRows": entry11,
} as const;
