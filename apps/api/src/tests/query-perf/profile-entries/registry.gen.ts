import entry0 from "./scheduled.caseLaw.backfillProvisionState";
import entry1 from "./scheduled.caseLaw.refreshCoverage";
import entry2 from "./scheduled.caseLaw.refreshSitemapShards";
import entry3 from "./scheduled.caseLaw.reportFreshness";
import entry4 from "./scheduled.chat.sendLimitReminders";
import entry5 from "./scheduled.chat.sweepCommandReceipts";
import entry6 from "./scheduled.dataExports.maintain";
import entry7 from "./scheduled.legislation.backfillExpressionIds";
import entry8 from "./scheduled.requests.sweepReceipts";
import entry9 from "./scheduled.usage.eraseHostedCustomers";
import entry10 from "./statement.caseLaw.backgroundReplayProbe";
import entry11 from "./statement.caseLaw.courtCatalogPage";
import entry12 from "./statement.caseLaw.coverageSources";
import entry13 from "./statement.caseLaw.euCompletionPage";
import entry14 from "./statement.caseLaw.quoteRecord";
import entry15 from "./statement.caseLaw.servableCandidateRevisions";
import entry16 from "./statement.documents.searchHits";
import entry17 from "./statement.legislation.candidateRows";

export default {
  "scheduled.caseLaw.backfillProvisionState": entry0,
  "scheduled.caseLaw.refreshCoverage": entry1,
  "scheduled.caseLaw.refreshSitemapShards": entry2,
  "scheduled.caseLaw.reportFreshness": entry3,
  "scheduled.chat.sendLimitReminders": entry4,
  "scheduled.chat.sweepCommandReceipts": entry5,
  "scheduled.dataExports.maintain": entry6,
  "scheduled.legislation.backfillExpressionIds": entry7,
  "scheduled.requests.sweepReceipts": entry8,
  "scheduled.usage.eraseHostedCustomers": entry9,
  "statement.caseLaw.backgroundReplayProbe": entry10,
  "statement.caseLaw.courtCatalogPage": entry11,
  "statement.caseLaw.coverageSources": entry12,
  "statement.caseLaw.euCompletionPage": entry13,
  "statement.caseLaw.quoteRecord": entry14,
  "statement.caseLaw.servableCandidateRevisions": entry15,
  "statement.documents.searchHits": entry16,
  "statement.legislation.candidateRows": entry17,
} as const;
