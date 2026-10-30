import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { readTimePolicy } from "@/api/lib/billing-time";

import { resolveSuggestionBillingDefault } from "./billing-default";
import { loadTimeSuggestions, serializeSuggestion } from "./load";
import {
  timeSuggestionDateSchema,
  timeSuggestionTimezoneSchema,
} from "./schemas";

const listTimeSuggestionsQuerySchema = v.object({
  date: timeSuggestionDateSchema,
  timezoneId: timeSuggestionTimezoneSchema,
});

const listTimeSuggestions = createSafeHandler(
  {
    contract: "patch",
    description:
      "List suggested time entries for one day in the current matter, drawn " +
      "from the signed-in user's own activity here: chat messages they sent " +
      "and records they created, edited, or downloaded. Each item carries a " +
      "fingerprint, the observed span, engaged minutes, and the evidence " +
      "behind it. Items the user already accepted or dismissed are omitted. " +
      "Accept one with time-entries.suggestions.accept or hide it with " +
      "time-entries.suggestions.dismiss.",
    permissions: { timeEntry: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      readClass: "tenant",
      reason: "billing_admin",
      consumesServices: false,
    },
    access: "read",
    query: listTimeSuggestionsQuerySchema,
  },
  async function* ({
    query,
    safeDb,
    session,
    user,
    workspaceId,
    featureAccessSnapshot,
  }) {
    const loaded = yield* loadTimeSuggestions({
      safeDb,
      featureAccessSnapshot,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      date: query.date,
      timezoneId: query.timezoneId,
    });
    const policy = yield* Result.await(
      readTimePolicy({
        safeDb,
        organizationId: session.activeOrganizationId,
      }),
    );
    const billingDefault = yield* resolveSuggestionBillingDefault({
      safeDb,
      workspaceId,
      userId: user.id,
      dateWorked: query.date,
    });
    const items = loaded.pending.map((cluster) =>
      serializeSuggestion(
        cluster,
        policy.timeMinimumUnitMinutes,
        billingDefault.billable,
      ),
    );

    return Result.ok({
      date: loaded.date,
      activeMinutes: items.reduce(
        (sum, suggestion) => sum + suggestion.durationMinutes,
        0,
      ),
      loggedMinutes: loaded.loggedMinutes,
      items,
    });
  },
);

export default listTimeSuggestions;
