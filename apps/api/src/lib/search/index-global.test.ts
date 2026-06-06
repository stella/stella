import { beforeEach, describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import { contactWorkspaceAccessSql } from "@/api/lib/search/contact-workspace-access-sql";
import { mapEntityHit } from "@/api/lib/search/global-search-mappers";
import { chatThreadScopeSql } from "@/api/lib/search/index-global";
import { clearRootDbMocks } from "@/api/tests/helpers/mock-root-db";

process.env["S3_ENDPOINT"] ??= "http://localhost:9000";
process.env["S3_BUCKET"] ??= "test";
process.env["S3_REGION"] ??= "us-east-1";

describe("global search SQL scope", () => {
  beforeEach(() => {
    clearRootDbMocks();
  });

  test("always constrains contact search to accessible workspaces", async () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      contactWorkspaceAccessSql({
        organizationId: toSafeId<"organization">("org_1"),
        accessibleWorkspaceIds: [
          toSafeId<"workspace">("ws_1"),
          toSafeId<"workspace">("ws_2"),
        ],
        selectedWorkspaceIds: [],
      }),
    );

    expect(compiled.sql).toContain("w.id = ANY");
    expect(compiled.sql).toContain("w.organization_id");
    expect(compiled.params).toEqual(["ws_1", "ws_2", "org_1"]);
  });

  test("intersects the user's selection with the accessible allowlist", async () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      contactWorkspaceAccessSql({
        organizationId: toSafeId<"organization">("org_1"),
        accessibleWorkspaceIds: [
          toSafeId<"workspace">("ws_1"),
          toSafeId<"workspace">("ws_2"),
        ],
        selectedWorkspaceIds: [toSafeId<"workspace">("ws_1")],
      }),
    );

    expect(compiled.sql).toContain("w.id = ANY");
    expect(compiled.params).toEqual(["ws_1", "org_1"]);
  });

  test("scopes chat search to the calling user, org, and data workspaces", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      chatThreadScopeSql({
        userId: toSafeId<"user">("user_1"),
        organizationId: toSafeId<"organization">("org_1"),
        accessibleWorkspaceIds: [
          toSafeId<"workspace">("ws_1"),
          toSafeId<"workspace">("ws_2"),
        ],
        selectedWorkspaceIds: [],
      }),
    );

    // The user filter is the privacy boundary: chat threads are
    // per-user, and searchGlobal runs on the RLS-bypassing root
    // connection, so a missing user_id predicate would leak other
    // users' conversations.
    expect(compiled.sql).toContain("t.user_id =");
    expect(compiled.sql).toContain("t.organization_id =");
    // A workspace-scoped thread must live in an accessible workspace,
    // and every embedded data workspace must stay within reach.
    expect(compiled.sql).toContain("t.workspace_id IS NULL");
    expect(compiled.sql).toContain("data_workspace_ids <@");
    // Two accessible-workspace arrays (workspace scope + data scope),
    // no selection clause: six params total.
    expect(compiled.params).toEqual([
      "user_1",
      "org_1",
      "ws_1",
      "ws_2",
      "ws_1",
      "ws_2",
    ]);
  });

  test("narrows chat search to the selected workspaces", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      chatThreadScopeSql({
        userId: toSafeId<"user">("user_1"),
        organizationId: toSafeId<"organization">("org_1"),
        accessibleWorkspaceIds: [
          toSafeId<"workspace">("ws_1"),
          toSafeId<"workspace">("ws_2"),
        ],
        selectedWorkspaceIds: [toSafeId<"workspace">("ws_1")],
      }),
    );

    expect(compiled.sql).toContain("t.workspace_id = ANY");
    expect(compiled.params).toEqual([
      "user_1",
      "org_1",
      "ws_1",
      "ws_2",
      "ws_1",
      "ws_2",
      "ws_1",
    ]);
  });

  test("maps the last editor avatar for document hits", () => {
    const { hit } = mapEntityHit({
      id: "entity_1",
      workspace_id: "ws_1",
      workspace_name: "Commercial dispute",
      type: "document",
      title: "Interim injunction memo.pdf",
      last_edited_by_name: "Clara Novak",
      last_edited_by_image: "https://example.test/clara.png",
      mime_type: "application/pdf",
      headline: "Interim injunction memo",
      score: 0.9,
      updated_at: new Date("2026-04-30T08:00:00.000Z"),
    });

    expect(hit).toMatchObject({
      type: "document",
      lastEditedByName: "Clara Novak",
      lastEditedByImage: "https://example.test/clara.png",
    });
  });
});
