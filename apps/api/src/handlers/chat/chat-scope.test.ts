import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { toSafeId } from "@/api/lib/branded-types";

const workspaceId = toSafeId<"workspace">(
  "019d0000-0000-7000-8000-000000000001",
);

describe("resolveChatScope", () => {
  test("global scope does not resolve workspace access", async () => {
    const getWorkspaceAccess = mock(() => Promise.resolve(null));

    const result = await Result.gen(() =>
      resolveChatScope({ getWorkspaceAccess }),
    );

    expect(result).toEqual(Result.ok({ scope: "global" }));
    expect(getWorkspaceAccess).not.toHaveBeenCalled();
  });

  test("resolves only the requested workspace and keeps archived reads", async () => {
    const getWorkspaceAccess = mock(() =>
      Promise.resolve({ id: workspaceId, status: "archived" as const }),
    );

    const result = await Result.gen(() =>
      resolveChatScope({ getWorkspaceAccess, workspaceId }),
    );

    expect(result).toEqual(Result.ok({ scope: "workspace", workspaceId }));
    expect(getWorkspaceAccess).toHaveBeenCalledTimes(1);
    expect(getWorkspaceAccess).toHaveBeenCalledWith(workspaceId);
  });

  test("rejects deleting and inaccessible workspaces", async () => {
    const deleting = await Result.gen(() =>
      resolveChatScope({
        getWorkspaceAccess: () =>
          Promise.resolve({ id: workspaceId, status: "deleting" }),
        workspaceId,
      }),
    );
    const inaccessible = await Result.gen(() =>
      resolveChatScope({
        getWorkspaceAccess: () => Promise.resolve(null),
        workspaceId,
      }),
    );

    expect(Result.isError(deleting)).toBe(true);
    expect(Result.isError(inaccessible)).toBe(true);
  });
});
