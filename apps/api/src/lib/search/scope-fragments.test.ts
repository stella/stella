import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
// `mock-root-db` must be imported before any module that pulls in the real
// `rootDb` singleton (index-global.ts does), so chatThreadScopeSql can be
// exercised without opening a database connection.
import "@/api/tests/helpers/mock-root-db";
import {
  contactWorkspaceAccessSql,
  resolveWorkspaceScope,
} from "@/api/lib/search/contact-workspace-access-sql";

const { chatThreadScopeSql } = await import("@/api/lib/search/index-global");

const organizationId = toSafeId<"organization">("org_1");
const userId = toSafeId<"user">("user_1");
const wsA = toSafeId<"workspace">("ws_a");
const wsB = toSafeId<"workspace">("ws_b");
const wsC = toSafeId<"workspace">("ws_c");

// These pure SQL-fragment builders are the tenant-scope chokepoints for the
// global search read path, which runs on the RLS-bypassing root pool. Locking
// their fail-closed behavior and their predicate shape means a regression that
// would leak cross-tenant rows trips CI rather than shipping.

describe("resolveWorkspaceScope fails closed", () => {
  test("no accessible workspaces resolves to null (never every workspace)", () => {
    expect(
      resolveWorkspaceScope({
        accessibleWorkspaceIds: [],
        selectedWorkspaceIds: [wsA],
      }),
    ).toBeNull();
  });

  test("a selection disjoint from the accessible set resolves to null", () => {
    expect(
      resolveWorkspaceScope({
        accessibleWorkspaceIds: [wsA, wsB],
        selectedWorkspaceIds: [wsC],
      }),
    ).toBeNull();
  });

  test("an empty selection scopes to the full accessible set", () => {
    expect(
      resolveWorkspaceScope({
        accessibleWorkspaceIds: [wsA, wsB],
        selectedWorkspaceIds: [],
      }),
    ).toEqual([wsA, wsB]);
  });

  test("a selection is intersected with the accessible set", () => {
    expect(
      resolveWorkspaceScope({
        accessibleWorkspaceIds: [wsA, wsB],
        selectedWorkspaceIds: [wsB, wsC],
      }),
    ).toEqual([wsB]);
  });
});

describe("contactWorkspaceAccessSql", () => {
  test("fails closed to `false` when no workspace is accessible", () => {
    const fragment = contactWorkspaceAccessSql({
      organizationId,
      accessibleWorkspaceIds: [],
      selectedWorkspaceIds: [],
    });
    expect(JSON.stringify(fragment)).toContain("false");
  });

  test("binds the org predicate and the accessible workspace allowlist", () => {
    const serialized = JSON.stringify(
      contactWorkspaceAccessSql({
        organizationId,
        accessibleWorkspaceIds: [wsA, wsB],
        selectedWorkspaceIds: [],
      }),
    );
    expect(serialized).toContain("organization_id");
    expect(serialized).toContain(organizationId);
    expect(serialized).toContain(wsA);
    expect(serialized).toContain(wsB);
  });
});

describe("chatThreadScopeSql reproduces the private-thread RLS scope", () => {
  test("always constrains owner, organization, and accessible workspaces", () => {
    const serialized = JSON.stringify(
      chatThreadScopeSql({
        userId,
        organizationId,
        accessibleWorkspaceIds: [wsA],
        selectedWorkspaceIds: [],
      }),
    );
    // A chat thread is private to its owner within its org; the fragment must
    // bind all three or a search could surface another user's threads.
    expect(serialized).toContain("user_id");
    expect(serialized).toContain(userId);
    expect(serialized).toContain("organization_id");
    expect(serialized).toContain(organizationId);
    expect(serialized).toContain("workspace_id");
    expect(serialized).toContain(wsA);
    // Embedded (cross-matter) workspace ids must stay within the caller's set.
    expect(serialized).toContain("data_workspace_ids");
  });
});
