import { Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import type { ActionKind } from "@/api/lib/rate-limit/action-kinds";
import type { ModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import {
  admitFixtureModelDispatch,
  type ModelDispatchAdmission,
} from "@/api/lib/rate-limit/model-dispatch-admission";

/**
 * The proof a test hands a model dispatch it calls directly, below the
 * admission wrapper that would mint it in production.
 */
export const testModelAdmission = (
  organizationId: SafeId<"organization">,
  actionKind: ActionKind = "chat.send",
): ModelDispatchAdmission =>
  admitFixtureModelDispatch({ organizationId, actionKind });

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
