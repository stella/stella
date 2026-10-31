import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db/safe-db";
import { createScopedDb } from "@/api/db/scoped";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { buildMcpContextFromChat } from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import { runRegistryReadTool } from "@/api/handlers/chat/tools/registry-adapter/run-registry-tool";
import { HttpStatusResponse } from "@/api/http/status";
import { LIST_MATTERS_LIST_PROJECTION } from "@/api/lib/chat/projections";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

import listMatters from "./list";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
beforeAll(async () => {
  fixture = await getRlsFixture();
});
afterAll(releaseRlsFixture);

test("API and code-mode matter lists preserve their shared field contract", async () => {
  const { ids, testDb } = fixture;
  const workspaceIds = [ids.wsA1, ids.wsA2];
  const scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, workspaceIds, ids.orgA, ids.userA1),
  );
  const safeDb = toSafeDbMock(scopedDb);
  const api = await listMatters.handler(
    asTestRaw<Parameters<typeof listMatters.handler>[0]>({
      safeDb,
      scopedDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1, email: "member@example.test" },
      memberRole: sessionMemberRole("member"),
      request: new Request("https://example.test/v1/workspaces"),
      route: "/v1/workspaces",
    }),
  );
  if (api instanceof HttpStatusResponse) {
    panic("Expected the matter list");
  }
  const registry = createChatRefRegistry();
  const context = authorizedMcpContextForTest(
    buildMcpContextFromChat({
      organizationId: ids.orgA,
      userId: ids.userA1,
      userEmail: "member@example.test",
      memberRole: sessionMemberRole("member"),
      safeDb,
      scopedDb,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        accessibleWorkspaceIds: workspaceIds,
        pinnedIds: [],
      }),
    }),
  );
  const result = await runRegistryReadTool({
    toolName: "list_matters",
    args: {},
    context,
    refRegistry: registry,
  });
  expect(result.isOk()).toBe(true);
  const chat = v.parse(LIST_MATTERS_LIST_PROJECTION, result.unwrap());
  expect(api.workspaces.length).toBeGreaterThan(0);
  expect(chat.matters).toHaveLength(api.workspaces.length);
  for (const row of api.workspaces) {
    const id = registry.toMatterRef(row.id);
    const actual = chat.matters.find((matter) => matter.id === id);
    expect(actual?.visibility).toBe(row.visibility);
    const expected = v.parse(
      v.object(LIST_MATTERS_LIST_PROJECTION.entries.matters.item.entries),
      {
        ...row,
        id,
        status: "active",
        lastActivityAt: row.lastActivityAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      },
    );
    expect(actual).toEqual(expected);
  }
});
