import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as v from "valibot";

import { connectableConnectorCatalogSchema } from "@stll/api-contract/chat-connector";

import type { ScopedDb } from "@/api/db/safe-db";
import { mcpConnectors } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createConnectorTools } from "@/api/handlers/chat/tools/connector-tools";
import { createSafeId } from "@/api/lib/branded-types";
import { loadConnectableMcpConnectorsForUser } from "@/api/lib/mcp-upstream/connections";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;

beforeAll(async () => {
  fixture = await getRlsFixture();
});

afterAll(releaseRlsFixture);

test("the catalog continuation expands through the tool in stable slug order", async () => {
  const { testDb, ids } = fixture;
  const rows = Array.from({ length: 21 }, (_, index) => ({
    id: createSafeId<"mcpConnector">(),
    slug: `catalog-${String(index).padStart(2, "0")}`,
    displayName: `Catalog ${index}`,
    organizationId: ids.orgA,
    description: "Test connector",
    url: "https://connector.example.test/mcp",
    authType: "none" as const,
  }));
  // Insertion order must not determine the prompt or its continuation.
  await testDb.insert(mcpConnectors).values(rows.toReversed());
  const safeDb = toSafeDbMock(
    asTestRaw<ScopedDb>(createScopedDb(testDb, [], ids.orgA, ids.userA1)),
  );
  const context = { safeDb, organizationId: ids.orgA, userId: ids.userA1 };
  const first = await loadConnectableMcpConnectorsForUser(context);
  expect(Result.isOk(first)).toBe(true);
  if (Result.isError(first)) {
    throw first.error;
  }
  expect(first.value.connectors.map(({ slug }) => slug)).toEqual(
    rows.slice(0, 20).map(({ slug }) => slug),
  );
  expect(first.value.continuation).toEqual({
    type: "more-available",
    afterSlug: "catalog-19",
  });
  expect(await loadConnectableMcpConnectorsForUser(context)).toEqual(first);
  expect(
    v.safeParse(connectableConnectorCatalogSchema, first.value).success,
  ).toBe(true);
  if (first.value.continuation.type !== "more-available") {
    throw new Error("Expected a continuation for 21 connectors");
  }
  const { execute } = createConnectorTools(context).list_connectable_connectors;
  if (execute === undefined) {
    throw new Error("Catalog discovery requires server execution");
  }
  const next = await execute({
    afterSlug: first.value.continuation.afterSlug,
  });
  expect(next).toEqual({
    status: "available",
    connectors: [{ slug: "catalog-20", displayName: "Catalog 20" }],
    continuation: { type: "complete" },
  });
});
