import { Result } from "better-result";
import * as v from "valibot";

import type { ChatLocalRunStepOutputGrant } from "@stll/api-contract/chat-local-run-step-output";
import { Temporal } from "@stll/time";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { ownerStepOutputGrant } from "@/api/lib/desktop-runner/step-output-grants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const params = v.object({ runId: v.pipe(v.string(), v.uuid()) });

const config = {
  contract: "patch",
  description:
    "A short-lived grant to read what the steps of your run on your computer " +
    "produced (a command's output, a file change's diff). The output stays " +
    "on that computer: the page reads it from stella desktop there, which " +
    "checks the grant against its own linked account. A run that is not " +
    "yours is a 404.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params,
} satisfies HandlerConfig;

type GrantDependencies = {
  control: () => Pick<DesktopRunnerControl, "readRunOutputKey">;
};

const answer = (grant: ChatLocalRunStepOutputGrant) => Result.ok(grant);

/** A grant for the member who owns the run, and for no one else. */
const createLocalRunStepOutputGrant = (dependencies?: GrantDependencies) =>
  createSafeRootHandler(
    config,
    async function* ({ params: { runId }, session, user }) {
      const owner = {
        userId: user.id,
        organizationId: session.activeOrganizationId,
      };
      const control =
        dependencies?.control() ?? getDesktopRunnerControl().control;
      const grant = yield* Result.await(
        ownerStepOutputGrant({
          control,
          owner,
          runId,
          now: Math.floor(Temporal.Now.instant().epochMilliseconds / 1000),
        }),
      );
      if (grant === null) {
        return Result.err(
          new HandlerError({
            status: 404,
            code: "not_found",
            message: "Local run not found",
          }),
        );
      }
      return answer(grant);
    },
  );

export default createLocalRunStepOutputGrant();
