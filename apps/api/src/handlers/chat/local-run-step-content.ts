import { Result } from "better-result";
import * as v from "valibot";

import { CHAT_LOCAL_RUN_STEP_CONTENT_WINDOW } from "@stll/api-contract/chat-local-run-step-content";
import {
  CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH,
  chatLocalRunOfCall,
} from "@stll/api-contract/chat-local-run-step-output";
import { numberFromString } from "@stll/api-contract/http-input";
import { sha256Hex } from "@stll/sha256/bun";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { stepContentAnswer } from "@/api/lib/desktop-runner/step-content-answer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const byteCount = (maximum: number) =>
  numberFromString(
    v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(maximum)),
  );

const config = {
  contract: "patch",
  description:
    "What one step of a run on your computer produced (a command's output, " +
    "a change's diff, a subagent's conversation, an image it viewed), as " +
    "stella stores it with the conversation. Text is answered in windows: " +
    "read on from `nextStart`. A thread that is not yours is a 404.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: v.object({
    threadId: resourceIdSchema("chatThread"),
    callId: v.pipe(
      v.string(),
      v.nonEmpty(),
      v.maxLength(CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH),
    ),
  }),
  query: v.object({
    start: v.optional(byteCount(CHAT_LOCAL_RUN_STEP_CONTENT_WINDOW.maxBytes)),
    limit: v.optional(byteCount(CHAT_LOCAL_RUN_STEP_CONTENT_WINDOW.maxBytes)),
  }),
} satisfies HandlerConfig;

type StepContentDependencies = {
  control: () => Pick<DesktopRunnerControl, "readStepContent">;
};

/** One step's content for the member who owns its thread, and for no one else. */
const createLocalRunStepContent = (dependencies?: StepContentDependencies) =>
  createSafeRootHandler(
    config,
    async function* ({
      params: { threadId, callId },
      query: {
        start = 0,
        limit = CHAT_LOCAL_RUN_STEP_CONTENT_WINDOW.defaultBytes,
      },
      session,
      user,
    }) {
      const runId = chatLocalRunOfCall(callId);
      if (runId === null) {
        return Result.err(
          new HandlerError({
            status: 404,
            code: "not_found",
            message: "Step not found",
          }),
        );
      }
      const control =
        dependencies?.control() ?? getDesktopRunnerControl().control;
      const content = yield* Result.await(
        control.readStepContent({
          owner: {
            userId: user.id,
            organizationId: session.activeOrganizationId,
          },
          threadId,
          stepKey: sha256Hex(callId),
          runId,
        }),
      );
      if (content === null) {
        return Result.err(
          new HandlerError({
            status: 404,
            code: "not_found",
            message: "Chat thread not found",
          }),
        );
      }
      return Result.ok(stepContentAnswer(content, { start, limit }));
    },
  );

export default createLocalRunStepContent();
