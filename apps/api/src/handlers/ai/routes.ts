import { routes } from "@/api/http/route";

import draftEmail from "./draft-email";
import summarizeEmail from "./summarize";

/** The Outlook add-in's email helpers. */
export const emailAIRoute = routes(
  {
    "/summarize": { POST: summarizeEmail },
    "/draft-email": { POST: draftEmail },
  },
  { prefix: "/ai" },
);
