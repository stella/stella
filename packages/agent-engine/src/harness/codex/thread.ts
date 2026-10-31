import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  type HarnessRunPolicy,
  HarnessStartError,
  type HarnessTurnInput,
} from "../adapter";
import type { HarnessContinuation } from "../events";
import type { AppServerClient } from "./app-server-client";
import { ThreadResponseSchema } from "./protocol";

/**
 * Opening the Codex thread a turn runs in: a new one, or the native session
 * the caller asked to resume. Resume reads metadata only (stella holds the
 * transcript) and unarchives an archived session first. When the session
 * cannot be resumed, a new thread starts and the outcome says why, so the
 * turn falls back to the portable transcript visibly.
 */

const SANDBOX_MODE = {
  workspace: "workspace-write",
} as const satisfies Record<HarnessRunPolicy["fs"], string>;
const NETWORK_ACCESS = {
  open: true,
} as const satisfies Record<HarnessRunPolicy["network"], boolean>;
/** The harness asks before acting outside its sandbox; stella relays it. */
const APPROVAL_POLICY = "on-request";
/** A dotted config key carries the name, so it must stay a bare TOML key. */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/u;

const ARCHIVED = /\barchived\b|\bunarchive\b/iu;
const SESSION_MISSING = /no rollout found|not found/iu;

const threadParams = (input: HarnessTurnInput) => {
  if (!MCP_SERVER_NAME.test(input.mcp.serverName)) {
    panic("Codex adapter: the MCP server name must be a bare TOML key");
  }
  return {
    model: input.model,
    cwd: input.workspaceDir,
    approvalPolicy: APPROVAL_POLICY,
    sandbox: SANDBOX_MODE[input.policy.fs],
    developerInstructions: input.instructions,
    config: {
      "sandbox_workspace_write.network_access":
        NETWORK_ACCESS[input.policy.network],
      // Only stella's server is overridden; others in the home survive. The
      // token travels over stdio, never on the command line.
      [`mcp_servers.${input.mcp.serverName}`]: {
        url: input.mcp.url,
        http_headers: { Authorization: `Bearer ${input.mcp.token}` },
        // The stella MCP server enforces its own approvals for writes.
        default_tools_approval_mode: "approve",
      },
    },
  };
};

const threadIdOf = (raw: unknown) => {
  const parsed = v.safeParse(ThreadResponseSchema, raw);
  return parsed.success ? parsed.output.thread.id : null;
};

type OpenedThread = {
  threadId: string;
  continuation: HarnessContinuation;
};

const startThread = async (
  client: AppServerClient,
  params: ReturnType<typeof threadParams>,
  continuation: HarnessContinuation,
): Promise<Result<OpenedThread, HarnessStartError>> => {
  const started = await client.request("thread/start", params);
  const threadId = Result.isOk(started) ? threadIdOf(started.value) : null;
  if (threadId === null) {
    return Result.err(
      new HarnessStartError({
        reason: "start_rejected",
        message: Result.isError(started)
          ? started.error.message
          : "The harness answered thread/start with an unexpected shape.",
      }),
    );
  }
  return Result.ok({ threadId, continuation });
};

export const openThread = async (
  client: AppServerClient,
  input: HarnessTurnInput,
): Promise<Result<OpenedThread, HarnessStartError>> => {
  const params = threadParams(input);
  if (input.continuation.type === "fresh") {
    return startThread(client, params, { type: "fresh" });
  }
  const threadId = input.continuation.sessionId;
  const resume = async () =>
    await client.request("thread/resume", {
      threadId,
      excludeTurns: true,
      ...params,
    });
  let resumed = await resume();
  if (Result.isError(resumed) && ARCHIVED.test(resumed.error.message)) {
    const unarchived = await client.request("thread/unarchive", { threadId });
    if (Result.isOk(unarchived)) {
      resumed = await resume();
    }
  }
  if (Result.isOk(resumed)) {
    const resumedId = threadIdOf(resumed.value);
    if (resumedId === null) {
      return Result.err(
        new HarnessStartError({
          reason: "protocol_violation",
          message:
            "The harness answered thread/resume with an unexpected shape.",
        }),
      );
    }
    return Result.ok({
      threadId: resumedId,
      continuation: { type: "resumed" },
    });
  }
  if (resumed.error.reason === "closed") {
    return Result.err(
      new HarnessStartError({
        reason: "harness_unavailable",
        message: resumed.error.message,
      }),
    );
  }
  return startThread(client, params, {
    type: "resume_unavailable",
    reason: SESSION_MISSING.test(resumed.error.message)
      ? "session_not_found"
      : "resume_rejected",
    message: resumed.error.message,
  });
};
