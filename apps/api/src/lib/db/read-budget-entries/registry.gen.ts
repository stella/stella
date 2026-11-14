import entry0 from "./scheduled.caseLaw.backfillProvisionState";
import entry1 from "./scheduled.caseLaw.refreshCoverage";
import entry2 from "./scheduled.caseLaw.refreshSitemapShards";
import entry3 from "./scheduled.caseLaw.reportFreshness";
import entry4 from "./scheduled.chat.sendLimitReminders";
import entry5 from "./scheduled.dataExports.maintain";
import entry6 from "./scheduled.legislation.backfillExpressionIds";
import entry7 from "./scheduled.requests.sweepReceipts";
import entry8 from "./scheduled.usage.eraseHostedCustomers";
import entry9 from "./statement.caseLaw.backgroundReplayProbe";
import entry10 from "./statement.caseLaw.courtCatalogPage";
import entry11 from "./statement.caseLaw.coverageSources";
import entry12 from "./statement.caseLaw.euCompletionPage";
import entry13 from "./statement.caseLaw.quoteRecord";
import entry14 from "./statement.documents.searchHits";
import entry15 from "./statement.legislation.candidateRows";

export default {
  "scheduled.caseLaw.backfillProvisionState": entry0,
  "scheduled.caseLaw.refreshCoverage": entry1,
  "scheduled.caseLaw.refreshSitemapShards": entry2,
  "scheduled.caseLaw.reportFreshness": entry3,
  "scheduled.chat.sendLimitReminders": entry4,
  "scheduled.dataExports.maintain": entry5,
  "scheduled.legislation.backfillExpressionIds": entry6,
  "scheduled.requests.sweepReceipts": entry7,
  "scheduled.usage.eraseHostedCustomers": entry8,
  "statement.caseLaw.backgroundReplayProbe": entry9,
  "statement.caseLaw.courtCatalogPage": entry10,
  "statement.caseLaw.coverageSources": entry11,
  "statement.caseLaw.euCompletionPage": entry12,
  "statement.caseLaw.quoteRecord": entry13,
  "statement.documents.searchHits": entry14,
  "statement.legislation.candidateRows": entry15,
} as const;
