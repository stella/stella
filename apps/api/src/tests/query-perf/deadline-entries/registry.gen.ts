import entry0 from "./scheduled.agentSkills.cleanOriginalObjects";
import entry1 from "./scheduled.caseLaw.backfillProvisionState";
import entry2 from "./scheduled.caseLaw.redactionTombstones.v3";
import entry3 from "./scheduled.caseLaw.refreshCoverage";
import entry4 from "./scheduled.caseLaw.refreshSitemapShards";
import entry5 from "./scheduled.caseLaw.reportFreshness";
import entry6 from "./scheduled.chat.sendLimitReminders";
import entry7 from "./scheduled.chat.sweepCommandReceipts";
import entry8 from "./scheduled.dataExports.maintain";
import entry9 from "./scheduled.dictation.deleteKeptTranscripts";
import entry10 from "./scheduled.legislation.backfillExpressionIds";
import entry11 from "./scheduled.requests.sweepReceipts";
import entry12 from "./scheduled.softLaw.sync";
import entry13 from "./scheduled.usage.eraseHostedCustomers";
import entry14 from "./statement.caseLaw.backgroundReplayProbe";
import entry15 from "./statement.caseLaw.courtCatalogPage";
import entry16 from "./statement.caseLaw.coverageSources";
import entry17 from "./statement.caseLaw.euCompletionPage";
import entry18 from "./statement.caseLaw.quoteRecord";
import entry19 from "./statement.caseLaw.servableCandidateRevisions";
import entry20 from "./statement.documents.searchHits";
import entry21 from "./statement.legislation.candidateRows";

export default {
  "scheduled.agentSkills.cleanOriginalObjects": entry0,
  "scheduled.caseLaw.backfillProvisionState": entry1,
  "scheduled.caseLaw.redactionTombstones.v3": entry2,
  "scheduled.caseLaw.refreshCoverage": entry3,
  "scheduled.caseLaw.refreshSitemapShards": entry4,
  "scheduled.caseLaw.reportFreshness": entry5,
  "scheduled.chat.sendLimitReminders": entry6,
  "scheduled.chat.sweepCommandReceipts": entry7,
  "scheduled.dataExports.maintain": entry8,
  "scheduled.dictation.deleteKeptTranscripts": entry9,
  "scheduled.legislation.backfillExpressionIds": entry10,
  "scheduled.requests.sweepReceipts": entry11,
  "scheduled.softLaw.sync": entry12,
  "scheduled.usage.eraseHostedCustomers": entry13,
  "statement.caseLaw.backgroundReplayProbe": entry14,
  "statement.caseLaw.courtCatalogPage": entry15,
  "statement.caseLaw.coverageSources": entry16,
  "statement.caseLaw.euCompletionPage": entry17,
  "statement.caseLaw.quoteRecord": entry18,
  "statement.caseLaw.servableCandidateRevisions": entry19,
  "statement.documents.searchHits": entry20,
  "statement.legislation.candidateRows": entry21,
} as const;
