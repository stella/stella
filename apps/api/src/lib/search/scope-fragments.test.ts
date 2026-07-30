import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import { chatThreadScopeSql } from "@/api/lib/search/chat-thread-scope-sql";
import {
  contactWorkspaceAccessSql,
  resolveWorkspaceScope,
  searchDocumentsAccessSql,
  workspaceSearchDocumentsAccessSql,
} from "@/api/lib/search/contact-workspace-access-sql";

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

describe("projection-specific workspace scopes", () => {
  const dialect = new PgDialect();
  const scope = {
    accessibleWorkspaceIds: [wsA],
    selectedWorkspaceIds: [],
  };

  test("fixes the entity projection alias", () => {
    const compiled = dialect.sqlToQuery(searchDocumentsAccessSql(scope));
    expect(compiled.sql).toContain("sd.workspace_id");
    expect(compiled.params).toContain(wsA);
  });

  test("fixes the matter projection alias", () => {
    const compiled = dialect.sqlToQuery(
      workspaceSearchDocumentsAccessSql(scope),
    );
    expect(compiled.sql).toContain("wsd.workspace_id");
    expect(compiled.params).toContain(wsA);
  });
});

describe("chatThreadScopeSql reproduces the private-thread RLS scope", () => {
  test("always constrains owner, organization, and accessible workspaces", () => {
    const fragment = chatThreadScopeSql({
      userId,
      organizationId,
      accessibleWorkspaceIds: [wsA],
      selectedWorkspaceIds: [],
    });
    const serialized = JSON.stringify(fragment);
    const compiled = new PgDialect().sqlToQuery(fragment);
    // The helper must bind the authorized thread to the protected projection;
    // otherwise any visible thread could authorize every search row.
    expect(compiled.sql).toContain("t.id = cst.thread_id");
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
