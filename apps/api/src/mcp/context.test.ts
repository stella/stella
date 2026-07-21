import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { createScopedDb } from "@/api/db/scoped";
import { loadAccessibleMcpWorkspaces } from "@/api/mcp/context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

setDefaultTimeout(120_000);

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await releaseRlsFixture();
});

describe("MCP workspace enumeration", () => {
  test("keeps the organization predicate and explicit subset when membership allows more", async () => {
    const explicitScope = createScopedDb(
      testDb,
      // userA1 also belongs to wsA2; a signed token subset must not inherit it
      // through membership mode. The foreign ID independently proves the
      // organization predicate remains active.
      [ids.wsA1, ids.wsB1],
      ids.orgA,
      ids.userA1,
    );

    const workspaces = await loadAccessibleMcpWorkspaces({
      organizationId: ids.orgA,
      scopedDb: asTestRaw<ScopedDb>(explicitScope),
    });

    expect(workspaces.map((workspace) => workspace.id)).toEqual([ids.wsA1]);
  });
});
