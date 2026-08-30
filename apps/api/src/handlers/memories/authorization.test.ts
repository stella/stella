import { describe, expect, test } from "bun:test";

import { canManageMemory } from "@/api/handlers/memories/authorization";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";

const activeWorkspaceId = createSafeId<"workspace">();
const archivedWorkspaceId = createSafeId<"workspace">();
const currentUserId = toSafeId<"user">("current-user");
const accessibleWorkspaces = [
  { id: activeWorkspaceId, status: "active" as const },
  { id: archivedWorkspaceId, status: "archived" as const },
];

describe("memory management authorization", () => {
  test("lets a user manage their own RLS-visible memory", () => {
    expect(
      canManageMemory({
        accessibleWorkspaces,
        currentUserId,
        memberRole: { role: "member" },
        memory: {
          scope: "user",
          userId: currentUserId,
          workspaceId: null,
        },
      }),
    ).toBe(true);
    expect(
      canManageMemory({
        accessibleWorkspaces,
        currentUserId,
        memberRole: { role: "member" },
        memory: {
          scope: "user",
          userId: toSafeId<"user">("another-user"),
          workspaceId: null,
        },
      }),
    ).toBe(false);
  });

  test("reserves firm memory management for firm memory managers", () => {
    expect(
      canManageMemory({
        accessibleWorkspaces,
        currentUserId,
        memberRole: { role: "admin" },
        memory: { scope: "organization", userId: null, workspaceId: null },
      }),
    ).toBe(true);
    expect(
      canManageMemory({
        accessibleWorkspaces,
        currentUserId,
        memberRole: { role: "owner" },
        memory: { scope: "organization", userId: null, workspaceId: null },
      }),
    ).toBe(true);
    expect(
      canManageMemory({
        accessibleWorkspaces,
        currentUserId,
        memberRole: { role: "member" },
        memory: { scope: "organization", userId: null, workspaceId: null },
      }),
    ).toBe(false);
  });

  test("requires update permission on an active accessible matter", () => {
    expect(
      canManageMemory({
        accessibleWorkspaces,
        currentUserId,
        memberRole: { role: "member" },
        memory: {
          scope: "workspace",
          userId: null,
          workspaceId: activeWorkspaceId,
        },
      }),
    ).toBe(true);
    expect(
      canManageMemory({
        accessibleWorkspaces,
        currentUserId,
        memberRole: { role: "member" },
        memory: {
          scope: "workspace",
          userId: null,
          workspaceId: archivedWorkspaceId,
        },
      }),
    ).toBe(false);
    expect(
      canManageMemory({
        accessibleWorkspaces,
        currentUserId,
        memberRole: { role: "member" },
        memory: {
          scope: "workspace",
          userId: null,
          workspaceId: createSafeId(),
        },
      }),
    ).toBe(false);
  });
});
