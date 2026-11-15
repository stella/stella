import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import {
  assertChatThreadScopeMatches,
  hasChatWorkspaceAccess,
  resolveChatScope,
} from "@/api/handlers/chat/chat-scope";
import { toSafeId } from "@/api/lib/branded-types";

const workspaceId = toSafeId<"workspace">(
  "019d0000-0000-7000-8000-000000000001",
);
const otherWorkspaceId = toSafeId<"workspace">(
  "019d0000-0000-7000-8000-000000000002",
);

describe("resolveChatScope", () => {
  test("global scope does not resolve workspace access", async () => {
    const getWorkspaceAccess = mock(async () => null);

    const result = await Result.gen(async function* () {
      const scope = yield* resolveChatScope({
        admitted: "active",
        getWorkspaceAccess,
      });
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
        admitted: "active-or-archived",
        getWorkspaceAccess,
        workspaceId,
      });
      return Result.ok(scope);
    });

    expect(result).toEqual(Result.ok({ scope: "workspace", workspaceId }));
    expect(getWorkspaceAccess).toHaveBeenCalledTimes(1);
    expect(getWorkspaceAccess).toHaveBeenCalledWith(workspaceId);
  });

  test("an archived matter is read-only: a write scope answers 404", async () => {
    const result = await Result.gen(async function* () {
      const scope = yield* resolveChatScope({
        admitted: "active",
        getWorkspaceAccess: async () => ({
          id: workspaceId,
          status: "archived",
        }),
        workspaceId,
      });
      return Result.ok(scope);
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ status: 404 });
    }
  });

  test("an active matter admits writes", async () => {
    const result = await Result.gen(async function* () {
      const scope = yield* resolveChatScope({
        admitted: "active",
        getWorkspaceAccess: async () => ({ id: workspaceId, status: "active" }),
        workspaceId,
      });
      return Result.ok(scope);
    });

    expect(result).toEqual(Result.ok({ scope: "workspace", workspaceId }));
  });

  test("rejects deleting and inaccessible workspaces", async () => {
    const deleting = await Result.gen(async function* () {
      const scope = yield* resolveChatScope({
        admitted: "active-or-archived",
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
        admitted: "active-or-archived",
        getWorkspaceAccess: async () => null,
        workspaceId,
      });
      return Result.ok(scope);
    });

    expect(Result.isError(deleting)).toBe(true);
    expect(Result.isError(inaccessible)).toBe(true);
  });
});

describe("assertChatThreadScopeMatches", () => {
  test("passes when a workspace thread is requested under its own scope", () => {
    const result = assertChatThreadScopeMatches({
      persistedWorkspaceId: workspaceId,
      scope: { scope: "workspace", workspaceId },
    });

    expect(Result.isOk(result)).toBe(true);
  });

  test("passes when a global thread is requested under global scope", () => {
    const result = assertChatThreadScopeMatches({
      persistedWorkspaceId: null,
      scope: { scope: "global" },
    });

    expect(Result.isOk(result)).toBe(true);
  });

  test("rejects a workspace thread requested under global scope", () => {
    const result = assertChatThreadScopeMatches({
      persistedWorkspaceId: workspaceId,
      scope: { scope: "global" },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.status).toBe(400);
    }
  });

  test("rejects a global thread requested under a workspace scope", () => {
    const result = assertChatThreadScopeMatches({
      persistedWorkspaceId: null,
      scope: { scope: "workspace", workspaceId },
    });

    expect(Result.isError(result)).toBe(true);
  });

  test("rejects a workspace thread requested under a different workspace", () => {
    const result = assertChatThreadScopeMatches({
      persistedWorkspaceId: workspaceId,
      scope: { scope: "workspace", workspaceId: otherWorkspaceId },
    });

    expect(Result.isError(result)).toBe(true);
  });
});

describe("persisted chat matter authorization", () => {
  test("global threads bypass matter lookup", async () => {
    const getWorkspaceAccess = mock(async () => null);
    expect(
      await hasChatWorkspaceAccess({
        admitted: "active",
        workspaceId: null,
        getWorkspaceAccess,
      }),
    ).toBe(true);
    expect(getWorkspaceAccess).not.toHaveBeenCalled();
  });

  test.each([
    { status: "active" as const, admitted: "active" as const, allowed: true },
    {
      status: "archived" as const,
      admitted: "active" as const,
      allowed: false,
    },
    {
      status: "deleting" as const,
      admitted: "active" as const,
      allowed: false,
    },
    {
      status: "active" as const,
      admitted: "active-or-archived" as const,
      allowed: true,
    },
    {
      status: "archived" as const,
      admitted: "active-or-archived" as const,
      allowed: true,
    },
    {
      status: "deleting" as const,
      admitted: "active-or-archived" as const,
      allowed: false,
    },
  ])(
    "checks a $status matter admitting $admitted",
    async ({ status, admitted, allowed }) => {
      const getWorkspaceAccess = mock(async () => ({
        id: workspaceId,
        status,
      }));
      expect(
        await hasChatWorkspaceAccess({
          admitted,
          workspaceId,
          getWorkspaceAccess,
        }),
      ).toBe(allowed);
      expect(getWorkspaceAccess).toHaveBeenCalledWith(workspaceId);
    },
  );

  test("refuses inaccessible matters", async () => {
    expect(
      await hasChatWorkspaceAccess({
        admitted: "active-or-archived",
        workspaceId,
        getWorkspaceAccess: async () => null,
      }),
    ).toBe(false);
  });
});
