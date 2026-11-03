import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { resolveCurrentChatRegistryContext } from "@/api/handlers/chat/tools/registry-adapter/current-execution-context";
import type { ChatRegistryContextDeps } from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import { toSafeId } from "@/api/lib/branded-types";
import { AuthorizedWorkspaceReadError } from "@/api/lib/workspaces/authorized-workspace-ids";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const contextDeps = asTestRaw<ChatRegistryContextDeps>({
  organizationId: toSafeId<"organization">("org_1"),
  userId: toSafeId<"user">("user_1"),
  toolWorkspaceIds: [],
});

describe("current chat execution context", () => {
  test("a failed matter read is a retryable refusal, not lost membership", async () => {
    const resolved = await resolveCurrentChatRegistryContext({
      contextDeps,
      resolveCurrentExecutionContext: async () =>
        await Promise.resolve(
          Result.err(
            new AuthorizedWorkspaceReadError({
              message: "Failed to read authorized workspaces",
              cause: new Error("connection reset"),
            }),
          ),
        ),
    });
    expect(Result.isError(resolved) && resolved.error.kind).toBe("transient");
  });

  test("a caller who left the organization is refused as no longer a member", async () => {
    const resolved = await resolveCurrentChatRegistryContext({
      contextDeps,
      resolveCurrentExecutionContext: async () =>
        await Promise.resolve(Result.ok(null)),
    });
    expect(Result.isError(resolved) && resolved.error.kind).toBe("unavailable");
  });
});
