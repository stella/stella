import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { toSafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { resourcesAreVisible } from "@/api/lib/entities/resource-access";
import {
  createTestHandlerContext,
  NO_AUDIT,
} from "@/api/tests/helpers/handler-context";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

test("ordinary inputs and creation identities do not require existing resource rows", async () => {
  const database = createScopedDbMock({
    select: () => createSelectQueryMock([]),
  });
  expect(
    await resourcesAreVisible({
      scopedDb: database.scopedDb,
      inputs: [
        {
          schema: v.object({
            name: v.string(),
            target: resourceIdSchema("entity", { usage: "creation" }),
          }),
          value: { name: "Ordinary task", target: "new-target" },
        },
      ],
    }),
  ).toBe(true);
  expect(database.getCallCount()).toBe(0);
});

for (const kind of ["entity", "entityVersion", "field"] as const) {
  test(`${kind} references in nested unions and arrays require visible rows`, async () => {
    const schema = v.object({
      entries: v.array(
        v.union([
          v.object({ id: resourceIdSchema(kind) }),
          v.object({ name: v.string() }),
        ]),
      ),
    });
    for (const visible of [false, true]) {
      const database = createScopedDbMock({
        select: () =>
          createSelectQueryMock(visible ? [{ id: "existing" }] : []),
      });
      expect(
        await resourcesAreVisible({
          scopedDb: database.scopedDb,
          inputs: [
            {
              schema,
              value: {
                entries: [
                  { id: "existing" },
                  { id: "existing" },
                  { name: "Ordinary" },
                ],
              },
            },
          ],
        }),
      ).toBe(visible);
      expect(database.getCallCount()).toBe(1);
    }
  });
}

test("generic handlers return the same missing response before resource details", async () => {
  let lookups = 0;
  const endpoint = createSafeRootHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      permissions: { workspace: ["read"] },
      mcp: { type: "internal", reason: "ui_navigation_state" },
      params: v.object({ entityId: resourceIdSchema("entity") }),
    },
    async function* () {
      lookups += 1;
      return Result.ok({ name: "Ordinary task" });
    },
  );
  for (const visible of [false, true]) {
    const database = createScopedDbMock({
      select: () => createSelectQueryMock(visible ? [{ id: "existing" }] : []),
    });
    const result = await endpoint.handler(
      createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
        audit: NO_AUDIT,
        params: { entityId: toSafeId<"entity">("existing") },
        safeDb: database.safeDb,
        scopedDb: database.scopedDb,
      }),
    );
    expect(result).toMatchObject(
      visible
        ? { name: "Ordinary task" }
        : { code: 404, response: { message: "Not found" } },
    );
    expect(lookups).toBe(visible ? 1 : 0);
  }
});

test("native task schemas retain visibility annotations without publishing them", async () => {
  const { getStaticMcpToolDefinition } =
    await import("@/api/mcp/static-tool-definitions");
  for (const name of ["list_tasks", "save_task", "delete_task"]) {
    const definition = getStaticMcpToolDefinition(name);
    expect(definition).toBeDefined();
    if (definition === undefined) {
      panic("Task definition required");
    }
    expect(JSON.stringify(definition.inputSchema)).not.toContain(
      "x-stella-resource-kind",
    );
    const input =
      "inputSchemaSource" in definition
        ? definition.inputSchemaSource
        : definition.inputSchema;
    const missing = createScopedDbMock({
      select: () => createSelectQueryMock([]),
    });
    expect(
      await resourcesAreVisible({
        inputs: [
          {
            schema: input,
            value: { task_id: "00000000-0000-4000-8000-000000000001" },
          },
        ],
        scopedDb: missing.scopedDb,
      }),
    ).toBe(false);
    expect(missing.getCallCount()).toBe(1);
    // A definition reconstructed only from its wire schema omits trusted metadata.
    expect(
      await resourcesAreVisible({
        inputs: [
          {
            schema: definition.inputSchema,
            value: { task_id: "00000000-0000-4000-8000-000000000001" },
          },
        ],
        scopedDb: missing.scopedDb,
      }),
    ).toBe(true);
  }
});
