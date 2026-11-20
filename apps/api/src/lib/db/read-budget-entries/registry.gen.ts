import entry0 from "./scheduled.agentSkills.cleanOriginalObjects";
import entry1 from "./scheduled.caseLaw.backfillProvisionState";
import entry2 from "./scheduled.caseLaw.refreshCoverage";
import entry3 from "./scheduled.caseLaw.refreshSitemapShards";
import entry4 from "./scheduled.caseLaw.reportFreshness";
import entry5 from "./scheduled.chat.sendLimitReminders";
import entry6 from "./scheduled.chat.sweepCommandReceipts";
import entry7 from "./scheduled.dataExports.maintain";
import entry8 from "./scheduled.dictation.deleteKeptTranscripts";
import entry9 from "./scheduled.legislation.backfillExpressionIds";
import entry10 from "./scheduled.requests.sweepReceipts";
import entry11 from "./scheduled.softLaw.sync";
import entry12 from "./scheduled.usage.eraseHostedCustomers";
import entry13 from "./statement.caseLaw.backgroundReplayProbe";
import entry14 from "./statement.caseLaw.courtCatalogPage";
import entry15 from "./statement.caseLaw.coverageSources";
import entry16 from "./statement.caseLaw.euCompletionPage";
import entry17 from "./statement.caseLaw.quoteRecord";
import entry18 from "./statement.caseLaw.servableCandidateRevisions";
import entry19 from "./statement.documents.searchHits";
import entry20 from "./statement.legislation.candidateRows";

export default {
  "scheduled.agentSkills.cleanOriginalObjects": entry0,
  "scheduled.caseLaw.backfillProvisionState": entry1,
  "scheduled.caseLaw.refreshCoverage": entry2,
  "scheduled.caseLaw.refreshSitemapShards": entry3,
  "scheduled.caseLaw.reportFreshness": entry4,
  "scheduled.chat.sendLimitReminders": entry5,
  "scheduled.chat.sweepCommandReceipts": entry6,
  "scheduled.dataExports.maintain": entry7,
  "scheduled.dictation.deleteKeptTranscripts": entry8,
  "scheduled.legislation.backfillExpressionIds": entry9,
  "scheduled.requests.sweepReceipts": entry10,
  "scheduled.softLaw.sync": entry11,
  "scheduled.usage.eraseHostedCustomers": entry12,
  "statement.caseLaw.backgroundReplayProbe": entry13,
  "statement.caseLaw.courtCatalogPage": entry14,
  "statement.caseLaw.coverageSources": entry15,
  "statement.caseLaw.euCompletionPage": entry16,
  "statement.caseLaw.quoteRecord": entry17,
  "statement.caseLaw.servableCandidateRevisions": entry18,
  "statement.documents.searchHits": entry19,
  "statement.legislation.candidateRows": entry20,
} as const;
