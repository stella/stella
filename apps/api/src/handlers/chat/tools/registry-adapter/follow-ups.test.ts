import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { toSafeId } from "@/api/lib/branded-types";
import {
  brandPersistedEntityId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import type { McpRequestContext } from "@/api/mcp/context";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

void mock.module("@/api/lib/analytics", () => ({
  captureError: mock(),
  captureRequestError: mock(),
  getAnalytics: mock(() => ({ capture: mock(), flush: mock() })),
}));

const { buildMcpContextFromChat } = await import("./mcp-chat-context");
const { runRegistryReadTool } = await import("./run-registry-tool");
const { containsRawUuid } = await import("./ref-mediation");

const WS_UUID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";
const ENTITY_UUID = "11111111-1111-4111-8111-111111111111";
const PROP_UUID = "22222222-2222-4222-8222-222222222222";
const FIELD_UUID = "33333333-3333-4333-8333-333333333333";
const TE_UUID = "55555555-5555-4555-8555-555555555555";
const INV_UUID = "66666666-6666-4666-8666-666666666666";

const buildContext = (tx: unknown): McpRequestContext => {
  const { safeDb, scopedDb } = createScopedDbMock(tx);
  return buildMcpContextFromChat({
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    safeDb,
    scopedDb,
    toolWorkspaceIds: resolveToolWorkspaceIds({
      accessibleWorkspaceIds: [toSafeId<"workspace">(WS_UUID)],
      pinnedIds: [],
    }),
    userId: toSafeId<"user">("user_1"),
  });
};

const chainable = (rows: readonly unknown[]) => {
  const builder = {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: async () => rows,
  };
  return builder;
};

describe("follow-up (b): read_document propertyId path", () => {
  test("hydrates fields[].propertyId to a property ref and entityId to its input ref", async () => {
    const refRegistry = createChatRefRegistry();
    const entityRef = refRegistry.toEntityRef({
      entityId: brandPersistedEntityId(ENTITY_UUID),
      workspaceId: brandPersistedWorkspaceId(WS_UUID),
    });

    const tx = {
      query: {
        entities: {
          findFirst: async () => ({
            workspaceId: WS_UUID,
            kind: "document",
            name: "Doc",
            currentVersionId: "ver_current",
          }),
        },
        fields: {
          findMany: async () => [
            {
              id: FIELD_UUID,
              propertyId: PROP_UUID,
              content: { version: 1, type: "text", value: "hello" },
            },
          ],
        },
      },
    };

    const result = await runRegistryReadTool({
      args: { entity_id: entityRef },
      context: buildContext(tx),
      refRegistry,
      toolName: "read_document",
    });

    expect(Result.isError(result)).toBe(false);
    const payload = result.unwrap();
    expect(payload).toMatchObject({
      entityId: entityRef,
      fields: [{ propertyId: "prop_1", id: FIELD_UUID }],
    });
    // The property UUID is gone; only the passthrough field-row id (a non-tenant
    // handle declared in passthroughIdPaths) remains UUID-shaped.
    expect(JSON.stringify(payload)).not.toContain(PROP_UUID);
  });
});

describe("follow-up (a): detail-mode workspace resolution from the fetched row", () => {
  test("list_time_entries by time_entry_id alone resolves the entry's entity ref", async () => {
    const refRegistry = createChatRefRegistry();
    const tx = {
      query: {
        timeEntries: { findFirst: async () => ({ workspaceId: WS_UUID }) },
      },
      select: () =>
        chainable([
          {
            id: TE_UUID,
            entityId: ENTITY_UUID,
            userId: null,
            dateWorked: "2026-01-01",
            durationMinutes: 60,
            billedMinutes: 60,
            rateAtEntry: 100,
            currency: "EUR",
            narrative: "work",
            invoiceNarrative: null,
            billable: true,
            noCharge: false,
            status: "draft",
          },
        ]),
    };

    const result = await runRegistryReadTool({
      // No matter_id: the workspace is unknowable from args and must come from
      // the fetched row. Before the fix this failed closed at entry.entityId.
      args: { time_entry_id: TE_UUID },
      context: buildContext(tx),
      refRegistry,
      toolName: "list_time_entries",
    });

    expect(Result.isError(result)).toBe(false);
    const payload = result.unwrap();
    expect(payload).toMatchObject({
      entry: { entityId: "ent_1", workspaceId: "mat_1" },
    });
    expect(JSON.stringify(payload)).not.toContain(ENTITY_UUID);
  });

  test("list_invoices by invoice_id alone resolves nested line-item entity refs", async () => {
    const refRegistry = createChatRefRegistry();
    const tx = {
      query: {
        invoices: {
          findFirst: async () => ({
            id: INV_UUID,
            workspaceId: WS_UUID,
            invoiceNumber: "INV-1",
            reference: "REF-1",
            status: "draft",
            invoiceDate: "2026-01-01",
            dueDate: "2026-02-01",
            currency: "EUR",
            totalAmount: 1000,
            notes: null,
            paidAt: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            timeEntries: [
              {
                id: TE_UUID,
                matterId: ENTITY_UUID,
                dateWorked: "2026-01-01",
                billedMinutes: 60,
                rateAtEntry: 100,
                currency: "EUR",
                narrative: "work",
                invoiceNarrative: null,
                status: "invoiced",
                matter: { id: ENTITY_UUID, name: "Deed" },
              },
            ],
            expenses: [],
          }),
        },
      },
    };

    const result = await runRegistryReadTool({
      args: { invoice_id: INV_UUID },
      context: buildContext(tx),
      refRegistry,
      toolName: "list_invoices",
    });

    expect(Result.isError(result)).toBe(false);
    const payload = result.unwrap();
    expect(payload).toMatchObject({
      invoice: {
        workspaceId: "mat_1",
        timeEntries: [{ entityId: "ent_1", entity: { id: "ent_1" } }],
      },
    });
    const serialized = JSON.stringify(payload);
    // The entity/workspace tenant UUIDs are fully replaced by refs.
    expect(serialized).not.toContain(ENTITY_UUID);
    expect(serialized).not.toContain(WS_UUID);
    // Invoice/line-item handles stay (declared passthrough), so some UUIDs
    // legitimately remain in the payload.
    expect(containsRawUuid(payload)).toBe(true);
    expect(serialized).toContain(INV_UUID);
  });
});
