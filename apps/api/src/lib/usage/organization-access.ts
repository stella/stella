/**
 * The one owner of "what standing does this organization have right now".
 * Every access decision (instance models, service-action budget, managed
 * model routing) is a `switch` projection of `OrganizationAccess`, so a new
 * standing cannot land without a decision at each of them.
 *
 * Under `FEATURE_FREE_TIER`, every standing that ends access today (an ended
 * or expired evaluation, lapsed paid access) resolves to the seeded `free`
 * policy instead. Lapsed paid access falls back to the standing recorded
 * before it, so a self-managed-keys organization stays on its own keys and a
 * running evaluation keeps running.
 */

import { panic, TaggedError } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { ORGANIZATION_ACCESS_STATE, usagePolicies } from "@/api/db/schema";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  CONFIGURED_ACCESS_STATE,
  configuredAccessDeadline,
} from "@/api/lib/usage/configured-access";
import type { OrganizationAccessSnapshot } from "@/api/lib/usage/organization-access-snapshot";

export type FreeTierPolicy = { serviceActionsPerPeriod: number };

/**
 * The deployment's free floor. `on` without a policy is a fault (the flag is
 * on but no active `free` policy is seeded): it resolves `unavailable`,
 * never a silent default.
 */
export type FreeTier =
  | { status: "off" }
  | { status: "on"; policy: FreeTierPolicy | undefined };

export const FREE_TIER_OFF = { status: "off" } as const satisfies FreeTier;

export type OrganizationAccess =
  | { type: "paid"; deadline: Date; serviceActionsPerPeriod: number }
  | { type: "evaluation"; endsAt: Date }
  | { type: "free"; serviceActionsPerPeriod: number }
  | { type: "self_managed_keys" }
  /** Access ended and no free floor applies (the flag is off). */
  | { type: "ended" }
  /** The standing cannot be resolved: a missing state row or free policy. */
  | { type: "unavailable" };

export type OrganizationAccessType = OrganizationAccess["type"];

const lapsedAccess = (freeTier: FreeTier): OrganizationAccess => {
  switch (freeTier.status) {
    case "off":
      return { type: "ended" };
    case "on":
      return freeTier.policy === undefined
        ? { type: "unavailable" }
        : {
            type: "free",
            serviceActionsPerPeriod: freeTier.policy.serviceActionsPerPeriod,
          };
    default:
      freeTier satisfies never;
      return panic("Unhandled free tier status");
  }
};

type ResolveOrganizationAccessOptions = {
  snapshot: OrganizationAccessSnapshot | undefined;
  now: Date;
  freeTier: FreeTier;
};

export const resolveOrganizationAccess = ({
  snapshot,
  now,
  freeTier,
}: ResolveOrganizationAccessOptions): OrganizationAccess => {
  if (snapshot === undefined) {
    return { type: "unavailable" };
  }
  switch (snapshot.state) {
    case ORGANIZATION_ACCESS_STATE.selfManagedKeys:
      return { type: "self_managed_keys" };
    case ORGANIZATION_ACCESS_STATE.evaluationPeriod:
      return snapshot.evaluationEndsAt !== null &&
        snapshot.evaluationEndsAt > now
        ? { type: "evaluation", endsAt: snapshot.evaluationEndsAt }
        : lapsedAccess(freeTier);
    case ORGANIZATION_ACCESS_STATE.evaluationEnded:
      return lapsedAccess(freeTier);
    case CONFIGURED_ACCESS_STATE: {
      const access = snapshot.configuredAccess;
      const deadline =
        access.status === "disabled" ? null : configuredAccessDeadline(access);
      if (access.status !== "disabled" && deadline !== null && deadline > now) {
        return {
          type: "paid",
          deadline,
          serviceActionsPerPeriod: access.serviceActionsPerPeriod,
        };
      }
      if (freeTier.status === "off") {
        return { type: "ended" };
      }
      return resolveOrganizationAccess({
        snapshot: snapshot.original,
        now,
        freeTier,
      });
    }
    default:
      snapshot satisfies never;
      return panic("Unhandled organization access state");
  }
};

class FreeTierPolicyMissingError extends TaggedError(
  "FreeTierPolicyMissingError",
)<{ message: string }> {}

const FREE_TIER_POLICY_MISSING = failureSink({
  event: "usage.free_tier_policy_missing",
  expected: [],
});

/**
 * The deployment's free floor: off without a query while the flag is off,
 * otherwise the active `free` policy (at most one, by a partial unique
 * index). A missing policy is observed and resolves `unavailable` downstream.
 */
export const readFreeTier = async (
  db: Pick<Transaction, "select">,
): Promise<FreeTier> => {
  if (!isDeploymentFeatureEnabled("FEATURE_FREE_TIER")) {
    return FREE_TIER_OFF;
  }
  const row = await db
    .select({
      serviceActionsPerPeriod: usagePolicies.serviceActionsPerPeriod,
    })
    .from(usagePolicies)
    .where(and(eq(usagePolicies.kind, "free"), eq(usagePolicies.active, true)))
    .limit(1)
    .then((rows) => rows.at(0));
  if (row === undefined) {
    observeFailure(
      new FreeTierPolicyMissingError({
        message: "FEATURE_FREE_TIER is on but no active free policy is seeded",
      }),
      { sink: FREE_TIER_POLICY_MISSING },
    );
    return { status: "on", policy: undefined };
  }
  return {
    status: "on",
    policy: {
      // The `usage_policies_free_shape` check keeps this set on free rows.
      serviceActionsPerPeriod:
        row.serviceActionsPerPeriod ??
        panic("Free policy has no service action budget"),
    },
  };
};
