import type { Result } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  ActionAdmissionError,
  actionAdmissionRefusal,
  withActionAdmission,
} from "@/api/lib/rate-limit/action-admission";
import type { PeriodActionKind } from "@/api/lib/rate-limit/action-kinds";
import {
  admitModelDispatch,
  type ModelDispatchAdmission,
} from "@/api/lib/rate-limit/model-dispatch-admission";

type AdmittedModelAction = {
  signal: AbortSignal;
  admission: ModelDispatchAdmission;
};

/**
 * Runs model work as one admitted action, for code that decides on its own
 * whether a model call is needed (a save that derives text only when its
 * inputs changed). Inside an admitted request or tool call of the same member
 * it joins that action instead of drawing another.
 */
export type ModelActionAdmitter = <T>(
  run: (admitted: AdmittedModelAction) => Promise<T>,
) => Promise<Result<T, unknown>>;

type CreateModelActionAdmitterOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  organizationStateDb: ScopedDb;
  actionKind: PeriodActionKind;
  admit?: typeof withActionAdmission;
};

export const createModelActionAdmitter =
  ({
    organizationId,
    userId,
    organizationStateDb,
    actionKind,
    admit = withActionAdmission,
  }: CreateModelActionAdmitterOptions): ModelActionAdmitter =>
  async (run) =>
    await admit({
      organizationId,
      userId,
      organizationStateDb,
      // No client idempotency key: each admitted run is its own action.
      periodIdentity: { actionKind, logicalPhaseId: Bun.randomUUIDv7() },
      run: async (signal) =>
        await run({
          signal,
          admission: admitModelDispatch({ organizationId, actionKind }),
        }),
    });

/**
 * The answer for a model action that admission did not start: the refusal's
 * own contract, or an unavailable admission.
 */
export const modelActionRefusal = (
  error: unknown,
): HandlerError<403 | 429 | 503> =>
  ActionAdmissionError.is(error)
    ? new HandlerError({ ...actionAdmissionRefusal(error), cause: error })
    : new HandlerError({
        status: 503,
        code: "service_unavailable",
        message: "Action admission is unavailable",
        cause: error,
      });
