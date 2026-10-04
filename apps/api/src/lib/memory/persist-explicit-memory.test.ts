import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { AccessibleWorkspace } from "@/api/lib/auth";
import { toSafeId } from "@/api/lib/branded-types";
import {
  memoryWriteRefusalChatToolError,
  memoryWriteRefusalHandlerError,
  resolveMemoryWriteScope,
} from "@/api/lib/memory/persist-explicit-memory";
import type {
  MemoryWriteRefusalCode,
  MemoryWriteScopeRequest,
} from "@/api/lib/memory/persist-explicit-memory";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const workspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());
const otherWorkspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());

type ResolveOptions = {
  accessibleWorkspaces?: readonly AccessibleWorkspace[];
  authority?: AuthorizedMemberRole;
  request: MemoryWriteScopeRequest;
};

const resolve = ({
  accessibleWorkspaces = [{ id: workspaceId, status: "active" }],
  authority = sessionMemberRole("member"),
  request,
}: ResolveOptions) =>
  resolveMemoryWriteScope({
    accessibleWorkspaces,
    authority,
    organizationId,
    request,
    userId,
  });

const refusalCode = (
  result: ReturnType<typeof resolve>,
): MemoryWriteRefusalCode | "ok" =>
  Result.isError(result) ? result.error.code : "ok";

describe("memory write scope", () => {
  test("refuses a matter-scoped memory for a matter the member cannot access", () => {
    expect(
      refusalCode(
        resolve({
          accessibleWorkspaces: [{ id: otherWorkspaceId, status: "active" }],
          request: { scope: "workspace", kind: "fact", workspaceId },
        }),
      ),
    ).toBe("workspace-not-found");
  });

  test("keeps an archived or deleting matter's memory read-only", () => {
    for (const status of ["archived", "deleting"] as const) {
      expect(
        refusalCode(
          resolve({
            accessibleWorkspaces: [{ id: workspaceId, status }],
            request: { scope: "workspace", kind: "fact", workspaceId },
          }),
        ),
      ).toBe("workspace-not-active");
    }
  });

  test("refuses matter memory to a chat-capable role without matter update", () => {
    expect(
      refusalCode(
        resolve({
          authority: sessionMemberRole("intern"),
          request: { scope: "workspace", kind: "fact", workspaceId },
        }),
      ),
    ).toBe("forbidden");
    expect(
      refusalCode(
        resolve({
          authority: sessionMemberRole("intern"),
          request: { scope: "user", kind: "preference" },
        }),
      ),
    ).toBe("ok");
  });

  test("refuses user memory to a role without chat", () => {
    expect(
      refusalCode(
        resolve({
          authority: sessionMemberRole("external"),
          request: { scope: "user", kind: "preference" },
        }),
      ),
    ).toBe("forbidden");
  });

  test("honours an attenuated credential below the member's role", () => {
    expect(
      refusalCode(
        resolve({
          authority: authorizedMemberRole({
            role: "owner",
            credential: {
              type: "attenuated",
              permissions: { chat: ["create"] },
            },
          }),
          request: { scope: "workspace", kind: "fact", workspaceId },
        }),
      ),
    ).toBe("forbidden");
  });

  test("refuses firm memory without the firm memory grant", () => {
    expect(
      refusalCode(
        resolve({
          authority: sessionMemberRole("member"),
          request: { scope: "organization", kind: "preference" },
        }),
      ),
    ).toBe("forbidden");
    expect(
      refusalCode(
        resolve({
          authority: sessionMemberRole("admin"),
          request: { scope: "organization", kind: "preference" },
        }),
      ),
    ).toBe("ok");
  });

  test("keeps matter-derived kinds at matter scope", () => {
    for (const kind of ["fact", "decision", "relationship"] as const) {
      expect(refusalCode(resolve({ request: { scope: "user", kind } }))).toBe(
        "kind-requires-workspace",
      );
      expect(
        refusalCode(
          resolve({
            authority: sessionMemberRole("owner"),
            request: { scope: "organization", kind },
          }),
        ),
      ).toBe("kind-requires-workspace");
      expect(
        refusalCode(
          resolve({ request: { scope: "workspace", kind, workspaceId } }),
        ),
      ).toBe("ok");
    }
  });

  test("binds an admitted write to the caller and the server-held matter", () => {
    const matter = resolve({
      request: { scope: "workspace", kind: "decision", workspaceId },
    });
    expect(matter.unwrap().target).toEqual({
      scope: "workspace",
      userId: null,
      workspaceId,
      kind: "decision",
      organizationId,
      createdBy: userId,
    });
    const personal = resolve({
      request: { scope: "user", kind: "instruction" },
    });
    expect(personal.unwrap().target).toEqual({
      scope: "user",
      userId,
      workspaceId: null,
      kind: "instruction",
      organizationId,
      createdBy: userId,
    });
  });

  test("reports an archived matter to REST exactly as an absent one", () => {
    const refusal = (
      accessibleWorkspaces: readonly AccessibleWorkspace[],
    ): { status: number; message: string } => {
      const result = resolve({
        accessibleWorkspaces,
        request: { scope: "workspace", kind: "fact", workspaceId },
      });
      if (Result.isOk(result)) {
        throw new Error("expected a refusal");
      }
      const { status, message } = memoryWriteRefusalHandlerError(result.error);
      return { status, message };
    };
    expect(refusal([{ id: workspaceId, status: "archived" }])).toEqual({
      status: 404,
      message: "Workspace not found",
    });
    expect(refusal([])).toEqual({
      status: 404,
      message: "Workspace not found",
    });
  });

  test("maps every refusal to a recoverable chat tool error", () => {
    const refusals = [
      resolve({
        accessibleWorkspaces: [],
        request: { scope: "workspace", kind: "fact", workspaceId },
      }),
      resolve({
        accessibleWorkspaces: [{ id: workspaceId, status: "archived" }],
        request: { scope: "workspace", kind: "fact", workspaceId },
      }),
      resolve({
        authority: sessionMemberRole("intern"),
        request: { scope: "workspace", kind: "fact", workspaceId },
      }),
      resolve({ request: { scope: "user", kind: "fact" } }),
    ];
    const codes = new Set<MemoryWriteRefusalCode>();
    for (const result of refusals) {
      if (Result.isOk(result)) {
        throw new Error("expected a refusal");
      }
      codes.add(result.error.code);
      expect(memoryWriteRefusalChatToolError(result.error).kind).toBe(
        "invalid-input",
      );
    }
    expect([...codes].toSorted()).toEqual([
      "forbidden",
      "kind-requires-workspace",
      "workspace-not-active",
      "workspace-not-found",
    ]);
  });
});
