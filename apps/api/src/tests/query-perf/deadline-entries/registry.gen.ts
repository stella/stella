import entry0 from "./scheduled.caseLaw.backfillProvisionState";
import entry1 from "./scheduled.caseLaw.refreshCoverage";
import entry2 from "./scheduled.caseLaw.refreshSitemapShards";
import entry3 from "./scheduled.caseLaw.reportFreshness";
import entry4 from "./scheduled.chat.sendLimitReminders";
import entry5 from "./scheduled.chat.sweepCommandReceipts";
import entry6 from "./scheduled.dataExports.maintain";
import entry7 from "./scheduled.dictation.deleteKeptTranscripts";
import entry8 from "./scheduled.legislation.backfillExpressionIds";
import entry9 from "./scheduled.requests.sweepReceipts";
import entry10 from "./scheduled.softLaw.sync";
import entry11 from "./scheduled.usage.eraseHostedCustomers";
import entry12 from "./statement.caseLaw.backgroundReplayProbe";
import entry13 from "./statement.caseLaw.courtCatalogPage";
import entry14 from "./statement.caseLaw.coverageSources";
import entry15 from "./statement.caseLaw.euCompletionPage";
import entry16 from "./statement.caseLaw.quoteRecord";
import entry17 from "./statement.caseLaw.servableCandidateRevisions";
import entry18 from "./statement.documents.searchHits";
import entry19 from "./statement.legislation.candidateRows";

export default {
  "scheduled.caseLaw.backfillProvisionState": entry0,
  "scheduled.caseLaw.refreshCoverage": entry1,
  "scheduled.caseLaw.refreshSitemapShards": entry2,
  "scheduled.caseLaw.reportFreshness": entry3,
  "scheduled.chat.sendLimitReminders": entry4,
  "scheduled.chat.sweepCommandReceipts": entry5,
  "scheduled.dataExports.maintain": entry6,
  "scheduled.dictation.deleteKeptTranscripts": entry7,
  "scheduled.legislation.backfillExpressionIds": entry8,
  "scheduled.requests.sweepReceipts": entry9,
  "scheduled.softLaw.sync": entry10,
  "scheduled.usage.eraseHostedCustomers": entry11,
  "statement.caseLaw.backgroundReplayProbe": entry12,
  "statement.caseLaw.courtCatalogPage": entry13,
  "statement.caseLaw.coverageSources": entry14,
  "statement.caseLaw.euCompletionPage": entry15,
  "statement.caseLaw.quoteRecord": entry16,
  "statement.caseLaw.servableCandidateRevisions": entry17,
  "statement.documents.searchHits": entry18,
  "statement.legislation.candidateRows": entry19,
} as const;
