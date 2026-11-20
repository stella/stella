import * as v from "valibot";

import { DESKTOP_RUNNER_MAX_BACKGROUND_TASKS } from "./desktop-runner";

/**
 * What a chat's agent left running in the background on the member's
 * computer after its last turn, while the chat waits for its next one:
 * `GET /chat/threads/:threadId/background-tasks`. Only a connected computer's
 * count holds; one that went away shows none.
 */
export const chatBackgroundTasksSchema = v.object({
  count: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(DESKTOP_RUNNER_MAX_BACKGROUND_TASKS),
  ),
});
export type ChatBackgroundTasks = v.InferOutput<
  typeof chatBackgroundTasksSchema
>;
