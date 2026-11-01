import { desktopEditSessions } from "@/api/db/schema";
import { defineTransitions } from "@/api/lib/db/transitions";

export const DESKTOP_EDIT_SESSION_TRANSITIONS = defineTransitions(
  desktopEditSessions,
  {
    open: ["finalized", "cancelled", "expired"],
    finalized: [],
    cancelled: [],
    expired: [],
  },
  { terminal: ["finalized", "cancelled", "expired"] },
);
