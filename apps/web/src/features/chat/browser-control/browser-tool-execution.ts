import { panic } from "better-result";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  type BrowserControlCommand,
  type BrowserControlResult,
  parseBrowserControlCommand,
} from "@stll/api-contract/browser-control";
import {
  BROWSER_STEP_GATE,
  type BrowserStepDecision,
} from "@stll/api-contract/browser-step-gate";

import {
  browserCommandHost,
  type BrowserSignInDecision,
} from "./browser-sign-in-handoff";

/** How a command runs: the chat turn it belongs to and its stop signal. */
export type BrowserCommandRun = {
  signal: AbortSignal;
  turnId: string;
};

type BrowserCommandExecutor = (
  input: unknown,
  toolCallId: string,
  run: BrowserCommandRun,
) => Promise<BrowserControlResult>;

/** Marks a command as running; the returned callback reports how it ended. */
type BeginBrowserCommand = () => (succeeded: boolean) => void;

/** How the shared browser gate answers a tool call's command right before it runs. */
type DecideBrowserCommand = (
  command: BrowserControlCommand,
  toolCallId: string,
) => BrowserStepDecision;

const refused = (
  code:
    | typeof BROWSER_CONTROL_ERROR_CODE.permissionDenied
    | typeof BROWSER_CONTROL_ERROR_CODE.needsMember,
  message: string,
): BrowserControlResult => ({
  code,
  message,
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
});

/** What a step Plan does not run answers, as a chat on a computer says it. */
const READ_ONLY = refused(
  BROWSER_CONTROL_ERROR_CODE.permissionDenied,
  "Plan mode is read-only: clicking, typing, pressing keys and choosing options are not available. Open and read pages to plan; propose those steps in the plan for the member to approve.",
);

/** What a step on a page waiting for the member's sign-in answers. */
const SIGN_IN_PENDING = refused(
  BROWSER_CONTROL_ERROR_CODE.needsMember,
  "The page in this tab asks for a sign-in, which the member completes themselves. Ask the member to sign in themselves, in the browser window that shows the page, then call snapshot. Do not fill in sign-in or verification fields.",
);

/**
 * The answer for a step the gate does not run, without reaching the
 * extension; null for a step that runs (the member or the level allowed it).
 */
const refusalOf = (
  decision: BrowserStepDecision,
): BrowserControlResult | null => {
  switch (decision.type) {
    case BROWSER_STEP_GATE.refuse:
      return READ_ONLY;
    case BROWSER_STEP_GATE.needsMember:
      return SIGN_IN_PENDING;
    case BROWSER_STEP_GATE.run:
    case BROWSER_STEP_GATE.ask:
      return null;
    default:
      decision satisfies never;
      return panic("Unhandled browser step decision");
  }
};

/**
 * Coalesces same-runtime retries. Durable at-most-once enforcement lives in
 * the extension and receives this same tool-call id across reloads. Each real
 * execution (never a coalesced retry, whose outcome is already recorded) is
 * reported to `beginCommand`, which decides when a reported page counts.
 * A step the gate refuses (Plan) or hands to the member (a sign-in) is
 * answered here and never reaches the extension; its card let it through so
 * this answer reaches the model.
 */
type WaitForSignIn = (options: {
  host: string | null;
  signal: AbortSignal;
}) => Promise<BrowserSignInDecision>;

const MAX_SIGN_IN_RETRIES = 3;

/**
 * Opens one step that reaches the extension, from its first command to its
 * result: the result it closes with is what the model gets (the chat's
 * downloads ride on it, `browser-download-inbox`).
 */
type OpenBrowserStep = () => {
  close: (result: BrowserControlResult) => Promise<BrowserControlResult>;
};

export const createBrowserToolExecutionCache = (
  execute: BrowserCommandExecutor,
  beginCommand: BeginBrowserCommand,
  decide: DecideBrowserCommand,
  {
    openStep,
    waitForSignIn,
  }: { openStep?: OpenBrowserStep; waitForSignIn?: WaitForSignIn } = {},
) => {
  const executions = new Map<string, Promise<BrowserControlResult>>();

  const run = async (
    toolCallId: string,
    input: unknown,
    commandRun: BrowserCommandRun,
  ): Promise<BrowserControlResult> => {
    // A malformed command goes to the extension, which refuses it.
    const command = parseBrowserControlCommand(input);
    const refusal =
      command === null ? null : refusalOf(decide(command, toolCallId));
    if (refusal !== null) {
      return refusal;
    }
    const finish = beginCommand();
    // Opened before the first command, so a download it starts, or one that
    // arrives during a sign-in hand-over, belongs to this step.
    const step = openStep?.();
    let succeeded = false;
    try {
      let result = await execute(input, toolCallId, commandRun);
      if (waitForSignIn !== undefined) {
        const host = browserCommandHost(input);
        for (
          let attempt = 1;
          attempt <= MAX_SIGN_IN_RETRIES &&
          result.status === "error" &&
          result.code === BROWSER_CONTROL_ERROR_CODE.needsMember;
          attempt += 1
        ) {
          const decision = await waitForSignIn({
            host,
            signal: commandRun.signal,
          });
          if (decision !== "resume") {
            break;
          }
          // After signing in, read the tab as it now stands without navigating away.
          result = await execute(
            { action: "snapshot" },
            `${toolCallId}:sign-in-${attempt}`,
            commandRun,
          );
        }
      }
      succeeded = result.status !== "error";
      return step === undefined ? result : await step.close(result);
    } finally {
      finish(succeeded);
    }
  };

  return {
    async executeOnce(
      toolCallId: string,
      input: unknown,
      commandRun: BrowserCommandRun,
    ) {
      const existing = executions.get(toolCallId);
      if (existing) {
        return await existing;
      }
      const execution = run(toolCallId, input, commandRun);
      executions.set(toolCallId, execution);
      return await execution;
    },
  };
};
