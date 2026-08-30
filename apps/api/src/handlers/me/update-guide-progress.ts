import { Result } from "better-result";
import { t } from "elysia";

import { createSafeSessionHandler } from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  GUIDE_PROGRESS_STATUSES,
  GUIDE_PROGRESS_TOUR_IDS,
  patchUserGuideProgress,
} from "@/api/lib/guide-progress";

const requestBody = t.Object(
  {
    tourId: t.UnionEnum(GUIDE_PROGRESS_TOUR_IDS),
    status: t.UnionEnum(GUIDE_PROGRESS_STATUSES),
  },
  { additionalProperties: false },
);

const config = {
  mcp: { type: "internal", reason: "auth_plumbing" },
  body: requestBody,
} satisfies SessionHandlerConfig;

export const createUpdateGuideProgressHandler = (
  updateGuideProgress: typeof patchUserGuideProgress = patchUserGuideProgress,
) =>
  createSafeSessionHandler(config, async function* ({ body, user }) {
    const guideProgress = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await updateGuideProgress({
            status: body.status,
            tourId: body.tourId,
            userId: user.id,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Internal server error",
            cause,
          }),
      }),
    );

    if (!guideProgress) {
      return Result.err(
        new HandlerError({ status: 404, message: "User not found" }),
      );
    }

    return Result.ok({ guideProgress });
  });

const updateGuideProgress = createUpdateGuideProgressHandler();
export default updateGuideProgress;
