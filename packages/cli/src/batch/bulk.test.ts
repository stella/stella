import { expect, test } from "bun:test";

import type { CapabilityLeafSpec } from "../route-types.js";
import {
  bulkIdsFlag,
  chunkCapabilityIds,
  contactBulkDeleteCapability,
  createCapabilityBulkHook,
} from "./bulk.js";
import type { BatchItem } from "./runner.js";

const spec = {
  capabilityId: "time-entries.batch.delete",
  commandPath: ["time-entries", "batch", "delete"],
  access: "write",
  destructive: false,
  flags: [],
  inputOnly: [],
  paginated: false,
  inputSchema: {
    type: "object",
    properties: {
      body: {
        type: "object",
        properties: { ids: { type: "array", maxItems: 200 } },
      },
    },
  },
} satisfies CapabilityLeafSpec;

test("ID chunks never exceed the endpoint schema ceiling and preserve context and order", () => {
  for (const length of [0, 1, 199, 200, 201, 401, 1000]) {
    const ids = Array.from({ length }, (_, index) => `id-${index}`);
    const chunks = chunkCapabilityIds(spec, {
      params: { matterId: "matter" },
      body: { ids, action: "approve" },
    });
    expect(
      chunks.flatMap((chunk) => {
        const body = chunk["body"];
        expect(chunk["params"]).toEqual({ matterId: "matter" });
        expect(body).toMatchObject({ action: "approve" });
        if (
          typeof body !== "object" ||
          body === null ||
          !("ids" in body) ||
          !Array.isArray(body.ids)
        ) {
          throw new TypeError("Expected chunk IDs");
        }
        expect(body.ids.length).toBeLessThanOrEqual(200);
        return body.ids;
      }),
    ).toEqual(ids);
  }
});

test("contact bulk hook depends on the active capability catalog", () => {
  expect(
    contactBulkDeleteCapability({ kind: "route", children: {} }),
  ).toBeUndefined();
  const contactSpec = { ...spec, capabilityId: "contacts.bulk.delete" };
  expect(
    contactBulkDeleteCapability({ kind: "capability-leaf", spec: contactSpec }),
  ).toBe(contactSpec);
});

const bulkSpec = (capabilityId: string): CapabilityLeafSpec => ({
  ...spec,
  capabilityId,
  idempotency: { type: "replay" },
  inputSchema: {
    type: "object",
    properties: {
      body: {
        type: "object",
        properties: { items: { type: "array", maxItems: 10 } },
      },
    },
  },
});

const item = (
  line: number,
  body: Record<string, unknown>,
  matterId = "matter",
): BatchItem => ({
  id: String(line),
  line,
  command: "properties create",
  input: { params: { matterId }, body },
  idempotencyKey: `key-${line}`,
});

test("property bulk mapping preserves item order and shared matter context", async () => {
  const target = bulkSpec("properties.batch.create");
  const first = item(1, { name: "First" });
  const second = item(2, { name: "Second" });
  const items = [first, second];
  const calls: Record<string, unknown>[] = [];
  const hook = createCapabilityBulkHook({
    spec: { ...spec, capabilityId: "properties.create" },
    tree: { kind: "capability-leaf", spec: target },
    invoke: async (invoked, input, members) => {
      expect(invoked).toBe(target);
      expect(members).toEqual(items);
      calls.push(input);
      return {
        status: "ok",
        result: { ids: ["property-first", "property-second"] },
      };
    },
  });
  expect(hook?.maxItems).toBe(10);
  expect(hook?.canGroup?.(first, second)).toBe(true);
  expect(hook?.canGroup?.(first, item(3, {}, "other-matter"))).toBe(false);
  expect(await hook?.execute(items)).toEqual([
    { status: "ok", result: { id: "property-first" } },
    { status: "ok", result: { id: "property-second" } },
  ]);
  expect(calls).toEqual([
    {
      params: { matterId: "matter" },
      body: { items: [{ name: "First" }, { name: "Second" }] },
    },
  ]);
});

test("matter-link bulk mapping restores input order across linked, existing, and rejected results", async () => {
  const linked = { decisionId: "new", id: "link-new" };
  const existing = { decisionId: "old", id: "link-old" };
  const rejected = { decisionId: "missing", reason: "not_found" };
  const hook = createCapabilityBulkHook({
    spec: { ...spec, capabilityId: "case-law.matter-links.create" },
    tree: {
      kind: "capability-leaf",
      spec: bulkSpec("case-law.matter-links.batch.create"),
    },
    invoke: async () => ({
      status: "ok",
      result: { linked: [linked], existing: [existing], rejected: [rejected] },
    }),
  });
  expect(
    await hook?.execute([
      item(1, { decisionId: "old" }),
      item(2, { decisionId: "missing" }),
      item(3, { decisionId: "new" }),
    ]),
  ).toEqual([
    { status: "ok", result: existing },
    { status: "error", error: rejected },
    { status: "ok", result: linked },
  ]);
});

test("bulk coalescing requires an equivalent active endpoint with durable replay", () => {
  const options = {
    spec: { ...spec, capabilityId: "properties.create" },
    tree: { kind: "capability-leaf", spec },
    invoke: async () => ({ status: "ok", result: {} }) as const,
  };
  expect(
    createCapabilityBulkHook({
      ...options,
      tree: { kind: "route", children: {} },
    }),
  ).toBeUndefined();
  expect(
    createCapabilityBulkHook({
      ...options,
      tree: {
        kind: "capability-leaf",
        spec: { ...spec, capabilityId: "properties.batch.create" },
      },
    }),
  ).toBeUndefined();
  expect(
    createCapabilityBulkHook({
      ...options,
      spec: { ...spec, capabilityId: "time-entries.delete" },
      tree: {
        kind: "capability-leaf",
        spec: bulkSpec("time-entries.batch.delete"),
      },
    }),
  ).toBeUndefined();
});

test("a sole domain-named bulk ID list gets an unambiguous IDs alias", () => {
  const claimIds = {
    flag: "--claim-ids",
    prop: "body.claimIds",
    part: "body",
    partPath: "claimIds",
    kind: "string-array",
    required: true,
    repeatable: true,
  } as const;
  expect(bulkIdsFlag({ ...spec, flags: [claimIds] })).toBe(claimIds);
  expect(
    bulkIdsFlag({
      ...spec,
      flags: [claimIds, { ...claimIds, partPath: "otherIds" }],
    }),
  ).toBeUndefined();
});

test("a successful write with missing bulk receipts remains unknown", async () => {
  for (const capabilityId of [
    "properties.create",
    "case-law.matter-links.create",
  ]) {
    const target =
      capabilityId === "properties.create"
        ? "properties.batch.create"
        : "case-law.matter-links.batch.create";
    const hook = createCapabilityBulkHook({
      spec: { ...spec, capabilityId },
      tree: { kind: "capability-leaf", spec: bulkSpec(target) },
      invoke: async () => ({ status: "ok", result: {} }),
    });
    const results = await hook?.execute([item(1, { decisionId: "missing" })]);
    expect(results?.at(0)?.status).toBe("unknown");
  }
});
