import entry0 from "./scheduled.caseLaw.backfillProvisionState";
import entry1 from "./scheduled.caseLaw.refreshCoverage";
import entry2 from "./scheduled.caseLaw.refreshSitemapShards";
import entry3 from "./scheduled.caseLaw.reportFreshness";
import entry4 from "./scheduled.legislation.backfillExpressionIds";
import entry5 from "./scheduled.requests.sweepReceipts";
import entry6 from "./scheduled.usage.eraseHostedCustomers";
import entry7 from "./statement.caseLaw.backgroundReplayProbe";
import entry8 from "./statement.caseLaw.coverageSources";
import entry9 from "./statement.caseLaw.euCompletionPage";
import entry10 from "./statement.caseLaw.globalSearchHits";
import entry11 from "./statement.documents.searchHits";
import entry12 from "./statement.legislation.candidateRows";

export default {
  "scheduled.caseLaw.backfillProvisionState": entry0,
  "scheduled.caseLaw.refreshCoverage": entry1,
  "scheduled.caseLaw.refreshSitemapShards": entry2,
  "scheduled.caseLaw.reportFreshness": entry3,
  "scheduled.legislation.backfillExpressionIds": entry4,
  "scheduled.requests.sweepReceipts": entry5,
  "scheduled.usage.eraseHostedCustomers": entry6,
  "statement.caseLaw.backgroundReplayProbe": entry7,
  "statement.caseLaw.coverageSources": entry8,
  "statement.caseLaw.euCompletionPage": entry9,
  "statement.caseLaw.globalSearchHits": entry10,
  "statement.documents.searchHits": entry11,
  "statement.legislation.candidateRows": entry12,
} as const;
