import { Result } from "better-result";
import { t } from "elysia";

import { createSafeHandler } from "@/api/lib/api-handlers";

import { loadTimeSuggestions, serializeSuggestion } from "./load";
import {
  timeSuggestionDateSchema,
  timeSuggestionTimezoneSchema,
} from "./schemas";

const listTimeSuggestionsQuerySchema = t.Object({
  date: timeSuggestionDateSchema,
  timezoneId: timeSuggestionTimezoneSchema,
});

const listTimeSuggestions = createSafeHandler(
  {
    description:
      "List suggested time entries for one day in the current matter, drawn " +
      "from the signed-in user's own activity here: chat messages they sent " +
      "and records they created, edited, or downloaded. Each item carries a " +
      "fingerprint, the observed span, engaged minutes, and the evidence " +
      "behind it. Items the user already accepted or dismissed are omitted. " +
      "Accept one with time-entries.suggestions.accept or hide it with " +
      "time-entries.suggestions.dismiss.",
    permissions: { timeEntry: ["read"] },
    mcp: { type: "capability", reason: "billing_admin" },
    access: "read",
    query: listTimeSuggestionsQuerySchema,
  },
  async function* ({ query, safeDb, session, user, workspaceId }) {
    const loaded = yield* loadTimeSuggestions({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      date: query.date,
      timezoneId: query.timezoneId,
    });

    return Result.ok({
      date: loaded.date,
      activeMinutes: loaded.pending.reduce(
        (sum, cluster) => sum + cluster.durationMinutes,
        0,
      ),
      items: loaded.pending.map(serializeSuggestion),
    });
  },
);

export default listTimeSuggestions;
