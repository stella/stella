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

// Keep the result intact until the code-mode surface raises failures for the SDK.
export const runChatScriptRead = async ({
  toolName,
  args,
  toolDefectMemo,
  read,
}: RunChatScriptReadProps): ReturnType<typeof runRegistryReadTool> => {
  if (toolDefectMemo.isKnownDefect(toolName, args)) {
    return Result.err(
      new ChatToolError({
        kind: "server-defect",
        message: knownDefectRefusalMessage(toolName),
      }),
    );
  }
  const result = await read();
  if (Result.isError(result) && result.error.kind === "server-defect") {
    toolDefectMemo.recordDefect(toolName, args);
  }
  return result;
};
