import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { toSafeId } from "@/api/lib/branded-types";

const workspaceId = toSafeId<"workspace">(
  "019d0000-0000-7000-8000-000000000001",
);

describe("resolveChatScope", () => {
  test("global scope does not resolve workspace access", async () => {
    const getWorkspaceAccess = mock(async () => null);

    const result = await Result.gen(async function* () {
      const scope = yield* resolveChatScope({ getWorkspaceAccess });
      return Result.ok(scope);
    });

    expect(result).toEqual(Result.ok({ scope: "global" }));
    expect(getWorkspaceAccess).not.toHaveBeenCalled();
  });

  test("resolves only the requested workspace and keeps archived reads", async () => {
    const getWorkspaceAccess = mock(async () => ({
      id: workspaceId,
      status: "archived" as const,
    }));

    const result = await Result.gen(async function* () {
      const scope = yield* resolveChatScope({
        getWorkspaceAccess,
        workspaceId,
      });
      return Result.ok(scope);
    });

    expect(result).toEqual(Result.ok({ scope: "workspace", workspaceId }));
    expect(getWorkspaceAccess).toHaveBeenCalledTimes(1);
    expect(getWorkspaceAccess).toHaveBeenCalledWith(workspaceId);
  });

  test("rejects deleting and inaccessible workspaces", async () => {
    const deleting = await Result.gen(async function* () {
      const scope = yield* resolveChatScope({
        getWorkspaceAccess: async () => ({
          id: workspaceId,
          status: "deleting",
        }),
        workspaceId,
      });
      return Result.ok(scope);
    });
    const inaccessible = await Result.gen(async function* () {
      const scope = yield* resolveChatScope({
        getWorkspaceAccess: async () => null,
        workspaceId,
      });
      return Result.ok(scope);
    });

    expect(Result.isError(deleting)).toBe(true);
    expect(Result.isError(inaccessible)).toBe(true);
  });
});
