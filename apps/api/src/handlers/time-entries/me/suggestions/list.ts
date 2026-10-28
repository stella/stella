import { panic, Result } from "better-result";
import { inArray } from "drizzle-orm";
import * as v from "valibot";

import { workspaces } from "@/api/db/schema";
import {
  resolveSuggestionBillingDefaults,
  suggestionBillingLookupKey,
} from "@/api/handlers/time-entries/suggestions/billing-default";
import {
  type LoadedSuggestionScope,
  loadTimeSuggestionRange,
  serializeSuggestion,
} from "@/api/handlers/time-entries/suggestions/load";
import {
  timeSuggestionDateSchema,
  timeSuggestionTimezoneSchema,
} from "@/api/handlers/time-entries/suggestions/schemas";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { readTimePolicy } from "@/api/lib/billing-time";
import type { SafeId } from "@/api/lib/branded-types";

const config = {
  contract: "patch",
  description:
    "List the signed-in user's pending suggested time entries across every " +
    "matter they can access, for startDate through endDate (one to seven " +
    "days, bounded in timezoneId). Days come in date order, each with its " +
    "matters and their suggestions; a day or matter with nothing pending is " +
    "omitted. Items carry the same fields as time-entries.suggestions.list. " +
    "Accept or dismiss one with time-entries.suggestions.decisions.create " +
    "on its matter.",
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
  query: v.object({
    startDate: timeSuggestionDateSchema,
    endDate: timeSuggestionDateSchema,
    timezoneId: timeSuggestionTimezoneSchema,
  }),
} satisfies HandlerConfig;

type MatterLabel = { id: SafeId<"workspace">; name: string; reference: string };

type SerializedSuggestion = ReturnType<typeof serializeSuggestion>;

type SuggestionDay = {
  date: string;
  matters: {
    matter: MatterLabel;
    activeMinutes: number;
    items: SerializedSuggestion[];
  }[];
};

const groupByDay = (
  scopes: readonly LoadedSuggestionScope[],
  matterFor: (workspaceId: SafeId<"workspace">) => MatterLabel,
  serialize: (scope: LoadedSuggestionScope) => SerializedSuggestion[],
) => {
  const days: SuggestionDay[] = [];
  for (const scope of scopes) {
    const items = serialize(scope);
    let day = days.at(-1);
    if (day?.date !== scope.date) {
      day = { date: scope.date, matters: [] };
      days.push(day);
    }
    day.matters.push({
      matter: matterFor(scope.workspaceId),
      activeMinutes: items.reduce((sum, item) => sum + item.durationMinutes, 0),
      items,
    });
  }
  return days;
};

const listMySuggestionRange = createSafeRootHandler(
  config,
  async function* ({
    query,
    safeDb,
    session,
    user,
    featureAccessSnapshot,
    getActiveWorkspaceIds,
  }) {
    // Matter access is decided here, once, by the same authorization every
    // cross-matter read uses; the loader filters every source to this list.
    const workspaceIds = yield* Result.await(
      Result.tryPromise(async () => await getActiveWorkspaceIds()),
    );
    const loaded = yield* loadTimeSuggestionRange({
      safeDb,
      featureAccessSnapshot,
      organizationId: session.activeOrganizationId,
      workspaceIds,
      userId: user.id,
      startDate: query.startDate,
      endDate: query.endDate,
      timezoneId: query.timezoneId,
    });
    const pending = loaded.filter((scope) => scope.pending.length > 0);
    const matterIds = [...new Set(pending.map((scope) => scope.workspaceId))];
    const matters =
      matterIds.length === 0
        ? []
        : yield* Result.await(
            safeDb((tx) =>
              tx
                .select({
                  id: workspaces.id,
                  name: workspaces.name,
                  reference: workspaces.reference,
                })
                .from(workspaces)
                .where(inArray(workspaces.id, matterIds))
                .limit(matterIds.length),
            ),
          );
    const matterById = new Map(matters.map((matter) => [matter.id, matter]));
    const policy = yield* Result.await(
      readTimePolicy({ safeDb, organizationId: session.activeOrganizationId }),
    );
    const billingDefaults = yield* resolveSuggestionBillingDefaults({
      safeDb,
      userId: user.id,
      lookups: pending.map((scope) => ({
        workspaceId: scope.workspaceId,
        dateWorked: scope.date,
      })),
    });

    return Result.ok({
      startDate: query.startDate,
      endDate: query.endDate,
      days: groupByDay(
        pending,
        (workspaceId: SafeId<"workspace">) =>
          matterById.get(workspaceId) ??
          panic("Suggested matter is missing from the authorized matters"),
        (scope) => {
          const billable =
            billingDefaults.get(
              suggestionBillingLookupKey({
                workspaceId: scope.workspaceId,
                dateWorked: scope.date,
              }),
            )?.billable ?? false;
          return scope.pending.map((cluster) =>
            serializeSuggestion(
              cluster,
              policy.timeMinimumUnitMinutes,
              billable,
            ),
          );
        },
      ),
    });
  },
);

export default listMySuggestionRange;
