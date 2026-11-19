import { routes } from "@/api/http/route";

import storeAwaitedStepContent from "./awaited-step-content";
import storeStepContent from "./step-content";
import upload from "./upload";

/**
 * The run's agent token authenticates these, not a member's session, so they
 * stay out of the chat table, whose every route is gated by member permissions.
 */
export const chatRunOutputsRoute = routes(
  {
    "/:runId/outputs": { POST: upload },
    "/:runId/steps/:stepKey/content": { PUT: storeStepContent },
  },
  { prefix: "/chat/local-runs" },
);

/**
 * The computer a run ran on authenticates this one, with its own credential
 * and device proof, for a run that is over.
 */
export const desktopRunnerAwaitedStepsRoute = routes(
  { "/:runId/steps/:stepKey/content": { PUT: storeAwaitedStepContent } },
  { prefix: "/desktop/runner/runs" },
);
