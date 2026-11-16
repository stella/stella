import { Result } from "better-result";

import type { Context } from "../context.js";
import { MCP_CAPABILITY_EXECUTORS } from "../generated/mcp-contract.js";
import { callTool, type CallToolResult } from "../mcp-client.js";
import { EXIT_CODES } from "../mcp-constants.js";
import type { CapabilityLeafSpec } from "../route-types.js";
import {
  maybeConfirmAndRetry,
  parsePayload,
  setExit,
  writersFor,
} from "../run-leaf-command.js";

type RunCapabilityChunksOptions = {
  context: Context;
  flags: Record<string, unknown>;
  spec: CapabilityLeafSpec;
  chunks: readonly Record<string, unknown>[];
  toolArgs: Record<string, unknown>;
  serverUrl: string;
  token: string;
  renderCall: (result: CallToolResult) => void;
};

/** Preserve one output document while independently reporting each bounded request. */
export const runCapabilityChunks = async ({
  context,
  flags,
  spec,
  chunks,
  toolArgs,
  serverUrl,
  token,
  renderCall,
}: RunCapabilityChunksOptions): Promise<void> => {
  const results: Record<string, unknown>[] = [];
  let failed = false;
  const toolName = MCP_CAPABILITY_EXECUTORS[spec.access];
  const appendResult = (result: CallToolResult) => {
    if (result.isError === true) {
      failed = true;
      results.push({
        status: "error",
        error: parsePayload(result) ?? result.content,
      });
    } else {
      results.push({
        status: "ok",
        result: parsePayload(result) ?? result.content,
      });
    }
  };
  for (const chunk of chunks) {
    const args = { ...toolArgs, input: chunk };
    const response = await callTool({
      serverUrl,
      token,
      name: toolName,
      args,
      ...(spec.requestTimeoutMs === undefined
        ? {}
        : { timeoutMs: spec.requestTimeoutMs }),
    });
    if (Result.isError(response)) {
      failed = true;
      results.push({
        status: "error",
        error: { message: response.error.message, kind: response.error.kind },
      });
      continue;
    }
    const before = results.length;
    const retried = await maybeConfirmAndRetry({
      args,
      call: response.value,
      context,
      enabled: spec.access === "write",
      flags,
      label: spec.commandPath.join(" "),
      renderCall: appendResult,
      serverUrl,
      timeoutMs: spec.requestTimeoutMs,
      token,
      toolName,
      writers: writersFor(context),
    });
    if (!retried) {
      appendResult(response.value);
    } else if (results.length === before) {
      results.push({
        status: "error",
        error: {
          message:
            "Chunk confirmation or retry failed; remaining chunks were not sent",
        },
      });
      failed = true;
      break;
    }
  }
  const exitBeforeRender = context.process.exitCode;
  renderCall({
    content: [{ type: "text", text: JSON.stringify({ chunks: results }) }],
  });
  if (failed) {
    setExit(
      context,
      exitBeforeRender === EXIT_CODES.aborted
        ? EXIT_CODES.aborted
        : EXIT_CODES.server,
    );
  }
};
