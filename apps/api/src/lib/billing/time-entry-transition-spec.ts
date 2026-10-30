import { timeEntries } from "@/api/db/schema";
import { defineTransitions } from "@/api/lib/db/transitions";

// A time entry's review lifecycle: a timekeeper submits a draft, an approver
// approves it or returns it to draft, invoicing bills an approved entry and a
// write-off retires one. The review moves go through this spec; invoicing,
// write-off and the matter batch actions are still direct writes in the
// shrinking ledger.
export const TIME_ENTRY_TRANSITIONS = defineTransitions(
  timeEntries,
  {
    draft: ["submitted", "approved", "written_off"],
    submitted: ["approved", "draft", "written_off"],
    approved: ["draft", "billed", "written_off"],
    billed: ["approved", "written_off"],
    written_off: ["draft"],
  },
  { terminal: [] },
);
