import { Result } from "better-result";

import { refreshVersionChanges } from "@/api/lib/legal-search/legislation-version-changes";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const VERSION_CHANGES_REFRESH_FAILURE = failureSink({
  event: "legislation.version_changes.refresh_failed",
  expected: [],
});

/** The corpus write stays committed; a replay or backfill retries its projection. */
export const recoverVersionChanges = async (
  options: Parameters<typeof refreshVersionChanges>[0],
): Promise<void> => {
  const refreshed = (
    await Result.tryPromise({
      try: async () => await refreshVersionChanges(options),
      catch: (cause) => cause,
    })
  ).andThen((outcome) => outcome);
  if (refreshed.isErr()) {
    observeFailure(refreshed.error, {
      sink: VERSION_CHANGES_REFRESH_FAILURE,
      ctx: {
        step: "legislation.versionChanges",
        ...(options.around === undefined ? {} : { documentId: options.around }),
      },
    });
  }
};
