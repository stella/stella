import { routes } from "@/api/http/route";

import askEmail from "./ask-email";
import draftEmail from "./draft-email";
import summarizeEmail from "./summarize";

/** The Outlook add-in's email helpers. */
export const emailAIRoute = routes(
  {
    "/summarize": { POST: summarizeEmail },
    "/draft-email": { POST: draftEmail },
    "/ask-email": { POST: askEmail },
  },
  { prefix: "/ai" },
);
