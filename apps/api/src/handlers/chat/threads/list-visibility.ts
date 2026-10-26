import { sql } from "drizzle-orm";

import { chatMessages, chatThreads } from "@/api/db/schema";

// Empty threads are placeholders and do not belong in chat history.
export const chatThreadHasMessages = sql`exists (
  select 1 from ${chatMessages}
  where ${chatMessages.threadId} = ${chatThreads.id}
)`;
