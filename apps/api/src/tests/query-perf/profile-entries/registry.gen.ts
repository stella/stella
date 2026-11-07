import entry0 from "./scheduled.caseLaw.backfillProvisionState";
import entry1 from "./scheduled.caseLaw.refreshCoverage";
import entry2 from "./scheduled.caseLaw.refreshSitemapShards";
import entry3 from "./scheduled.caseLaw.reportFreshness";
import entry4 from "./scheduled.legislation.backfillExpressionIds";
import entry5 from "./scheduled.requests.sweepReceipts";
import entry6 from "./scheduled.usage.eraseHostedCustomers";
import entry7 from "./statement.caseLaw.backgroundReplayProbe";
import entry8 from "./statement.caseLaw.courtCatalogPage";
import entry9 from "./statement.caseLaw.coverageSources";
import entry10 from "./statement.caseLaw.euCompletionPage";
import entry11 from "./statement.caseLaw.globalSearchHits";
import entry12 from "./statement.caseLaw.quoteRecord";
import entry13 from "./statement.documents.searchHits";
import entry14 from "./statement.legislation.candidateRows";

export default {
  "scheduled.caseLaw.backfillProvisionState": entry0,
  "scheduled.caseLaw.refreshCoverage": entry1,
  "scheduled.caseLaw.refreshSitemapShards": entry2,
  "scheduled.caseLaw.reportFreshness": entry3,
  "scheduled.legislation.backfillExpressionIds": entry4,
  "scheduled.requests.sweepReceipts": entry5,
  "scheduled.usage.eraseHostedCustomers": entry6,
  "statement.caseLaw.backgroundReplayProbe": entry7,
  "statement.caseLaw.courtCatalogPage": entry8,
  "statement.caseLaw.coverageSources": entry9,
  "statement.caseLaw.euCompletionPage": entry10,
  "statement.caseLaw.globalSearchHits": entry11,
  "statement.caseLaw.quoteRecord": entry12,
  "statement.documents.searchHits": entry13,
  "statement.legislation.candidateRows": entry14,
} as const;
