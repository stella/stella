import { panic } from "better-result";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  type BrowserControlResult,
} from "@stll/api-contract/browser-control";
import { browserSiteGrantOrigin } from "@stll/api-contract/browser-site-grants";

import type { BrowserApprovalProvenance } from "./browser-approval-mode";

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

/** Who answered `toolCallId`, as this tab recorded it. */
type ApprovalProvenanceFor = (toolCallId: string) => BrowserApprovalProvenance;

const WITHHELD: BrowserControlResult = {
  code: BROWSER_CONTROL_ERROR_CODE.redirected,
  message:
    "The tab is now on a website the user has not allowed, so the page was not read. Take a snapshot; the user is asked first.",
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
};

/**
 * A command a website approval answered may only hand back a page on the
 * website it was allowed for. The extension reports where the tab ended up; a
 * page elsewhere (a link, a redirect, going back, or the user moving the tab
 * before it ran) is withheld from the model, and the command counts as failed
 * so the next one asks. When this tab cannot tell who answered, the page is
 * withheld too.
 */
const withinSiteGrant = (
  result: BrowserControlResult,
  provenance: BrowserApprovalProvenance,
): BrowserControlResult => {
  if (result.status !== "success") {
    return result;
  }
  switch (provenance.type) {
    case "person":
      return result;
    case "site-grant":
      return browserSiteGrantOrigin(result.snapshot.url) === provenance.origin
        ? result
        : WITHHELD;
    case "unreadable":
      return WITHHELD;
    default:
      provenance satisfies never;
      return panic("Unhandled browser approval provenance");
  }
};

/**
 * Coalesces same-runtime retries. Durable at-most-once enforcement lives in
 * the extension and receives this same tool-call id across reloads. Each real
 * execution (never a coalesced retry, whose outcome is already recorded) is
 * reported to `beginCommand`, which gates auto-approval.
 */
export const createBrowserToolExecutionCache = (
  execute: BrowserCommandExecutor,
  beginCommand: BeginBrowserCommand,
  approvalProvenanceFor: ApprovalProvenanceFor,
) => {
  const executions = new Map<string, Promise<BrowserControlResult>>();

  const run = async (
    toolCallId: string,
    input: unknown,
    commandRun: BrowserCommandRun,
  ) => {
    const finish = beginCommand();
    // Read before the command runs: what answered it must not depend on the
    // record still being there, or readable, once the result comes back.
    const provenance = approvalProvenanceFor(toolCallId);
    let succeeded = false;
    try {
      const result = withinSiteGrant(
        await execute(input, toolCallId, commandRun),
        provenance,
      );
      succeeded = result.status === "success";
      return result;
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
