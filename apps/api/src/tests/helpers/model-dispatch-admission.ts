import { panic, Result } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import type { ActionKind } from "@/api/lib/rate-limit/action-kinds";
import type { ModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import {
  admitFixtureModelDispatch,
  type ModelDispatchAdmission,
} from "@/api/lib/rate-limit/model-dispatch-admission";
import {
  MANAGED_MODEL_TIER,
  type ManagedModelTier,
} from "@/api/lib/usage/managed-model-tier";

/**
 * The proof a test hands a model dispatch it calls directly, below the
 * admission wrapper that would mint it in production.
 */
export const testModelAdmission = (
  organizationId: SafeId<"organization">,
  actionKind: ActionKind = "chat.send",
  modelTier: ManagedModelTier = MANAGED_MODEL_TIER.standard,
): ModelDispatchAdmission =>
  admitFixtureModelDispatch({ organizationId, actionKind, modelTier });

/**
 * The organization scope an admission wrapper reads the managed model tier
 * through, for tests that run with `FEATURE_FREE_TIER` off: the tier is then
 * standard without a read, so a read is a test that needs a real scope.
 */
export const testOrganizationStateDb: ScopedDb = async () =>
  await Promise.resolve(
    panic("The test read organization state; give it a database scope"),
  );

/** An admitter that admits every run, for code under test that starts one. */
export const testModelActionAdmitter =
  (
    organizationId: SafeId<"organization">,
    actionKind: ActionKind = "chat.send",
  ): ModelActionAdmitter =>
  async (run) =>
    await Result.tryPromise({
      try: async () =>
        await run({
          signal: new AbortController().signal,
          admission: testModelAdmission(organizationId, actionKind),
        }),
      catch: (cause: unknown) => cause,
    });
