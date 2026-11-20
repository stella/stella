import entry0 from "./agentSkills.cleanOriginalObjects.oneMinute";
import entry1 from "./caseLaw.backfillProvisionState.minutely";
import entry2 from "./caseLaw.refreshCoverage.fiveMinute";
import entry3 from "./caseLaw.refreshSitemapShards.hourly";
import entry4 from "./caseLaw.reportFreshness.fiveMinute";
import entry5 from "./chat.sendLimitReminders.minute";
import entry6 from "./chat.sweepCommandReceipts.tenMinute";
import entry7 from "./dataExports.maintain.fiveMinute";
import entry8 from "./dictation.deleteKeptTranscripts.minute";
import entry9 from "./legislation.backfillExpressionIds.fiveMinute";
import entry10 from "./requests.sweepReceipts.hourly";
import entry11 from "./softLaw.sync.daily";
import entry12 from "./usage.eraseHostedCustomers.minute";

export default {
  "agentSkills.cleanOriginalObjects.oneMinute": entry0,
  "caseLaw.backfillProvisionState.minutely": entry1,
  "caseLaw.refreshCoverage.fiveMinute": entry2,
  "caseLaw.refreshSitemapShards.hourly": entry3,
  "caseLaw.reportFreshness.fiveMinute": entry4,
  "chat.sendLimitReminders.minute": entry5,
  "chat.sweepCommandReceipts.tenMinute": entry6,
  "dataExports.maintain.fiveMinute": entry7,
  "dictation.deleteKeptTranscripts.minute": entry8,
  "legislation.backfillExpressionIds.fiveMinute": entry9,
  "requests.sweepReceipts.hourly": entry10,
  "softLaw.sync.daily": entry11,
  "usage.eraseHostedCustomers.minute": entry12,
} as const;
