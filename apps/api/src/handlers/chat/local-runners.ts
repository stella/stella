import { Result } from "better-result";

import {
  type ChatLocalHarnessReadiness,
  type ChatLocalRunReadiness,
  isChatLocalRunHarness,
} from "@stll/api-contract/chat-run-target";
import { DESKTOP_RUNNER_FEATURE_ID } from "@stll/api-contract/desktop-runner";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { loadFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";

const config = {
  contract: "patch",
  // Whoever may send a chat turn may see where it can run; the answer
  // describes only the member's own computers.
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
} satisfies HandlerConfig;

/** One answer type for every branch, so the route infers the whole union. */
const answer = (readiness: ChatLocalRunReadiness) => Result.ok(readiness);

type LocalRunnersDependencies = {
  control: () => Pick<DesktopRunnerControl, "readMemberRunners">;
};

/**
 * The member's computers and what each harness a chat turn can run on last
 * reported (ready with its models, sign-in needed, limited until a time, not
 * installed). `hidden` when the member cannot run chat turns on a computer,
 * so the composer offers nothing.
 */
export const createLocalRunnersEndpoint = (
  dependencies?: LocalRunnersDependencies,
) =>
  createSafeRootHandler(config, async function* ({ safeDb, session, user }) {
    const owner = {
      userId: user.id,
      organizationId: session.activeOrganizationId,
    };
    const snapshot = yield* Result.await(
      loadFeatureAccessSnapshot({ safeDb, ...owner }),
    );
    if (!isFeatureEnabled(snapshot, DESKTOP_RUNNER_FEATURE_ID, owner)) {
      return answer({ status: "hidden" });
    }
    const control =
      dependencies?.control() ?? getDesktopRunnerControl().control;
    const runners = await control.readMemberRunners({ owner });
    if (runners.isErr()) {
      return Result.err(
        new HandlerError({
          status: 503,
          code: "internal_error",
          message: "Computers are unavailable right now.",
          cause: runners.error,
        }),
      );
    }
    const enabled: ChatLocalRunReadiness = {
      status: "enabled",
      runners: runners.value.map((runner) => ({
        desktopId: runner.desktopId,
        connected: runner.connected,
        lastSeenAt: runner.lastSeenAt.toISOString(),
        harnesses: runner.harnesses.flatMap(
          (report): ChatLocalHarnessReadiness[] =>
            isChatLocalRunHarness(report.id)
              ? [{ ...report, id: report.id }]
              : [],
        ),
      })),
    };
    return answer(enabled);
  });

export default createLocalRunnersEndpoint();
