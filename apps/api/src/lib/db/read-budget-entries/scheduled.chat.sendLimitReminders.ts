import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  reads: { pages: 1000 },
  writes: {
    pagesPerWrittenRow: 30,
    ceilingPagesPerRun: 4000,
    reason:
      "Each run deletes at most 200 due reminders by key and files at most one notification per reminder; thirty pages per written row cover the heap and index entries of both.",
  },
  reason:
    "One run takes at most 200 due reminders through the remind_at index, then reads the newest turn of each of those chats through the thread index and each chat's matter by key: about 600 row visits at a few pages each for a full batch. Reminders not yet due stay outside the index range, so the measured 25-reminder batch reads the same pages beside 1,000 and 10,000 of them.",
} as const satisfies ReadBudget;
