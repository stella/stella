import entry0 from "./scheduled.caseLaw.backfillProvisionState";
import entry1 from "./scheduled.caseLaw.refreshCoverage";
import entry2 from "./scheduled.caseLaw.refreshSitemapShards";
import entry3 from "./scheduled.caseLaw.reportFreshness";
import entry4 from "./scheduled.chat.sendLimitReminders";
import entry5 from "./scheduled.chat.sweepCommandReceipts";
import entry6 from "./scheduled.dataExports.maintain";
import entry7 from "./scheduled.legislation.backfillExpressionIds";
import entry8 from "./scheduled.requests.sweepReceipts";
import entry9 from "./scheduled.softLaw.sync";
import entry10 from "./scheduled.usage.eraseHostedCustomers";
import entry11 from "./statement.caseLaw.backgroundReplayProbe";
import entry12 from "./statement.caseLaw.courtCatalogPage";
import entry13 from "./statement.caseLaw.coverageSources";
import entry14 from "./statement.caseLaw.euCompletionPage";
import entry15 from "./statement.caseLaw.quoteRecord";
import entry16 from "./statement.caseLaw.servableCandidateRevisions";
import entry17 from "./statement.documents.searchHits";
import entry18 from "./statement.legislation.candidateRows";

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
  "scheduled.softLaw.sync": entry9,
  "scheduled.usage.eraseHostedCustomers": entry10,
  "statement.caseLaw.backgroundReplayProbe": entry11,
  "statement.caseLaw.courtCatalogPage": entry12,
  "statement.caseLaw.coverageSources": entry13,
  "statement.caseLaw.euCompletionPage": entry14,
  "statement.caseLaw.quoteRecord": entry15,
  "statement.caseLaw.servableCandidateRevisions": entry16,
  "statement.documents.searchHits": entry17,
  "statement.legislation.candidateRows": entry18,
} as const;
