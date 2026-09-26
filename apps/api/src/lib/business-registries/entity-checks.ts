import { panic, Result } from "better-result";

import { runEntityCheck } from "@stll/business-registries/entity-checks";
import type {
  EntityCheckKind,
  EntityCheckResult,
  EntityCheckSubject,
} from "@stll/business-registries/entity-checks";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

// Shared by the HTTP route, the check_counterparty MCP tool and the
// counterparty_check chat tool.

export type RunEntityCheckSharedProps = {
  check: EntityCheckKind;
  subject: EntityCheckSubject;
  signal?: AbortSignal | undefined;
  runCheck?: typeof runEntityCheck | undefined;
};

/**
 * Screen a subject against one official source. A source that could not
 * answer is an `unavailable` outcome, not an error: the caller must see that
 * the check did not run rather than a missing result.
 */
export const runEntityCheckShared = async ({
  check,
  subject,
  signal,
  runCheck = runEntityCheck,
}: RunEntityCheckSharedProps): Promise<
  Result<EntityCheckResult, HandlerError>
> => {
  const result = await runCheck({ kind: check, subject, signal });
  if (result.isOk()) {
    return Result.ok(result.value);
  }
  const error = result.error;
  switch (error._tag) {
    case "EntityCheckInputError": {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "validation_error",
          message: error.message,
        }),
      );
    }
    case "EntityCheckCancelledError": {
      return Result.err(
        new HandlerError({
          status: 503,
          code: "entity_check_cancelled",
          message: "The check was cancelled before the source answered",
        }),
      );
    }
    default: {
      error satisfies never;
      return panic("Unhandled error");
    }
  }
};
