import { Result } from "better-result";

import type { RegistryReadToolName } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import type { runRegistryReadTool } from "@/api/handlers/chat/tools/registry-adapter/run-registry-tool";
import {
  knownDefectRefusalMessage,
  type ChatToolDefectMemo,
} from "@/api/lib/chat/tool-defect-memo";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

type RunChatScriptReadProps = {
  toolName: RegistryReadToolName;
  args: unknown;
  toolDefectMemo: ChatToolDefectMemo;
  read: () => ReturnType<typeof runRegistryReadTool>;
};

// Code mode consumes reads through a Promise rejection contract. Preserve the
// tagged error so the SDK can turn it into a script failure rather than a value.
export const runChatScriptRead = async ({
  toolName,
  args,
  toolDefectMemo,
  read,
}: RunChatScriptReadProps): Promise<unknown> => {
  if (toolDefectMemo.isKnownDefect(toolName, args)) {
    throw new ChatToolError({
      kind: "server-defect",
      message: knownDefectRefusalMessage(toolName),
    });
  }
  const result = await read();
  if (Result.isError(result)) {
    if (result.error.kind === "server-defect") {
      toolDefectMemo.recordDefect(toolName, args);
    }
    throw result.error;
  }
  return result.value;
};
