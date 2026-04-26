import { describe, expect, test } from "bun:test";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import type {
  contacts,
  entities,
  invoices,
  properties,
  workspaces,
} from "@/api/db/schema";
import type { AnyDrizzle } from "@/api/db/scoped";
import { createScopedDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

describe("branded types", () => {
  describe("toSafeId", () => {
    test("produces a value equal to the input string", () => {
      const raw = "org_abc123";
      const safe = toSafeId<"organization">(raw);
      expect(safe === raw).toBe(true);
    });

    test("produces a workspace SafeId", () => {
      const raw = "ws_xyz789";
      const safe = toSafeId<"workspace">(raw);
      // @ts-expect-error - safe isn't the same type as raw
      expect(safe).toBe(raw);
    });

    test("can be used where SafeId<T> is expected", () => {
      const acceptsOrgId = (id: SafeId<"organization">) => id;
      const safe = toSafeId<"organization">("org_test");
      // Should compile and return the same value
      expect(acceptsOrgId(safe)).toBe(safe);
    });

    test("plain string is not assignable to SafeId (type-level)", () => {
      const acceptsOrgId = (_id: SafeId<"organization">) => _id;
      // @ts-expect-error - plain string should not satisfy SafeId
      acceptsOrgId("raw-string");
    });

    test("SafeId<organization> is not assignable to SafeId<workspace> (type-level)", () => {
      const acceptsWorkspaceId = (_id: SafeId<"workspace">) => _id;
      const orgId = toSafeId<"organization">("org_123");
      // @ts-expect-error - organization SafeId should not satisfy workspace SafeId
      acceptsWorkspaceId(orgId);
    });
  });

  describe("branded schema columns", () => {
    test("select model returns SafeId<organization> for org FK columns", () => {
      type ContactSelect = InferSelectModel<typeof contacts>;
      type OrgIdType = ContactSelect["organizationId"];
      const check: OrgIdType = toSafeId<"organization">("test");
      expect(check).toBeDefined();
      // @ts-expect-error - plain string not assignable
      const bad: OrgIdType = "plain-string";
      expect(bad).toBeDefined();
    });

    test("select model returns SafeId<workspace> for ws FK columns", () => {
      type EntitySelect = InferSelectModel<typeof entities>;
      type WsIdType = EntitySelect["workspaceId"];
      const check: WsIdType = toSafeId<"workspace">("test");
      expect(check).toBeDefined();
      // @ts-expect-error - plain string not assignable
      const bad: WsIdType = "plain-string";
      expect(bad).toBeDefined();
    });

    test("insert model requires SafeId<organization>", () => {
      type ContactInsert = InferInsertModel<typeof contacts>;
      type OrgIdInsert = ContactInsert["organizationId"];
      const check: OrgIdInsert = toSafeId<"organization">("test");
      expect(check).toBeDefined();
      // @ts-expect-error - plain string not assignable
      const bad: OrgIdInsert = "plain-string";
      expect(bad).toBeDefined();
    });

    test("SafeId<organization> is not assignable to SafeId<workspace> column", () => {
      type EntityInsert = InferInsertModel<typeof entities>;
      type WsIdInsert = EntityInsert["workspaceId"];
      const orgId = toSafeId<"organization">("org_test");
      // @ts-expect-error - org SafeId should not work for ws column
      const bad: WsIdInsert = orgId;
      expect(bad).toBeDefined();
    });

    test("PK columns are branded by table domain", () => {
      type WorkspaceSelect = InferSelectModel<typeof workspaces>;
      type PkType = WorkspaceSelect["id"];
      const check: PkType = toSafeId<"workspace">("workspace_test");
      expect(check).toBe(toSafeId<"workspace">("workspace_test"));
      // @ts-expect-error - plain string not assignable
      const bad: PkType = "plain-string";
      expect(bad).toBeDefined();
    });

    test("multiple tables share consistent branded types", () => {
      type ContactOrg = InferSelectModel<typeof contacts>["organizationId"];
      type InvoiceOrg = InferSelectModel<typeof invoices>["organizationId"];
      const orgId = toSafeId<"organization">("org_test");
      const a: ContactOrg = orgId;
      const b: InvoiceOrg = orgId;
      expect(a).toBe(b);
    });

    test("workspace FK from different tables are interchangeable", () => {
      type EntityWs = InferSelectModel<typeof entities>["workspaceId"];
      type PropertyWs = InferSelectModel<typeof properties>["workspaceId"];
      const wsId = toSafeId<"workspace">("ws_test");
      const a: EntityWs = wsId;
      const b: PropertyWs = wsId;
      expect(a).toBe(b);
    });
  });

  describe("createScopedDb", () => {
    test("requires branded workspace ID arrays", () => {
      const fakeDb = {
        transaction: async <TResult>(
          fn: (tx: {
            execute: (query: unknown) => Promise<unknown>;
          }) => Promise<TResult>,
        ) =>
          await fn({
            execute: async (_query: unknown) => ({}),
          }),
      } satisfies AnyDrizzle;

      createScopedDb(
        fakeDb,
        [toSafeId<"workspace">("ws_test")],
        toSafeId<"organization">("org_test"),
        toSafeId<"user">("user_test"),
      );

      createScopedDb(
        fakeDb,
        // @ts-expect-error - plain strings must not satisfy the RLS workspace boundary
        ["ws_test"],
        toSafeId<"organization">("org_test"),
        toSafeId<"user">("user_test"),
      );
    });
  });
});
