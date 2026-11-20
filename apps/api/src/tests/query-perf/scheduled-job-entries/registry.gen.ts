import entry0 from "./agentSkills.cleanOriginalObjects.oneMinute";
import entry1 from "./caseLaw.backfillProvisionState.minutely";
import entry2 from "./caseLaw.backfillRedactionTombstones.v3";
import entry3 from "./caseLaw.refreshCoverage.fiveMinute";
import entry4 from "./caseLaw.refreshSitemapShards.hourly";
import entry5 from "./caseLaw.reportFreshness.fiveMinute";
import entry6 from "./chat.sendLimitReminders.minute";
import entry7 from "./chat.sweepCommandReceipts.tenMinute";
import entry8 from "./dataExports.maintain.fiveMinute";
import entry9 from "./dictation.deleteKeptTranscripts.minute";
import entry10 from "./legislation.backfillExpressionIds.fiveMinute";
import entry11 from "./requests.sweepReceipts.hourly";
import entry12 from "./softLaw.sync.daily";
import entry13 from "./usage.eraseHostedCustomers.minute";

export default {
  "agentSkills.cleanOriginalObjects.oneMinute": entry0,
  "caseLaw.backfillProvisionState.minutely": entry1,
  "caseLaw.backfillRedactionTombstones.v3": entry2,
  "caseLaw.refreshCoverage.fiveMinute": entry3,
  "caseLaw.refreshSitemapShards.hourly": entry4,
  "caseLaw.reportFreshness.fiveMinute": entry5,
  "chat.sendLimitReminders.minute": entry6,
  "chat.sweepCommandReceipts.tenMinute": entry7,
  "dataExports.maintain.fiveMinute": entry8,
  "dictation.deleteKeptTranscripts.minute": entry9,
  "legislation.backfillExpressionIds.fiveMinute": entry10,
  "requests.sweepReceipts.hourly": entry11,
  "softLaw.sync.daily": entry12,
  "usage.eraseHostedCustomers.minute": entry13,
} as const;
