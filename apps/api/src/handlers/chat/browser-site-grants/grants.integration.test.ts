import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";

import { chatBrowserSiteGrants } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { HttpStatusResponse } from "@/api/http/status";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createOrganizationScopedTestDb,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import {
  BROWSER_SITE_GRANTS_PAGE,
  browserSiteGrantsScalingScenario,
  seedBrowserSiteGrantsScaling,
} from "@/api/tests/read-scaling/chat-browser-site-grants";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createBrowserSiteGrant from "./create";
import deleteBrowserSiteGrant from "./delete";
import listBrowserSiteGrants from "./list";

// Website approvals live in the API: what one session stores, a later read
// (another device, a reload) returns, per user and organization.

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

const clearGrants = async () => {
  await testDb
    .delete(chatBrowserSiteGrants)
    .where(
      and(
        eq(chatBrowserSiteGrants.organizationId, ids.orgA),
        eq(chatBrowserSiteGrants.userId, ids.userA1),
      ),
    );
};

afterEach(clearGrants);

afterAll(async () => {
  await clearGrants();
  await releaseRlsFixture();
});

const audits: unknown[] = [];
const collectAudit: AuditRecorder = async (_tx, event) => {
  audits.push(event);
  await Promise.resolve();
};

const principal = (userId: SafeId<"user"> = ids.userA1) => ({
  audit: collectAudit,
  safeDb: createSafeDb(testDb, [], ids.orgA, userId),
  scopedDb: createOrganizationScopedTestDb(testDb, {
    organizationId: ids.orgA,
    userId,
  }),
  session: { activeOrganizationId: ids.orgA },
  user: { id: userId },
});

const store = async (url: string, userId?: SafeId<"user">) =>
  await createBrowserSiteGrant.handler(
    createTestHandlerContext<
      Parameters<typeof createBrowserSiteGrant.handler>[0]
    >({
      ...principal(userId),
      body: { url },
      request: new Request("https://example.test/v1/chat/browser-site-grants", {
        method: "POST",
      }),
      route: "/v1/chat/browser-site-grants",
    }),
  );

const reload = async (userId?: SafeId<"user">) => {
  const result = await listBrowserSiteGrants.handler(
    createTestHandlerContext<
      Parameters<typeof listBrowserSiteGrants.handler>[0]
    >({ ...principal(userId), query: {} }),
  );
  if (result instanceof HttpStatusResponse) {
    return panic(`Expected a grant list, received status ${result.code}`);
  }
  return result.grants;
};

const remove = async (grantId: SafeId<"chatBrowserSiteGrant">) =>
  await deleteBrowserSiteGrant.handler(
    createTestHandlerContext<
      Parameters<typeof deleteBrowserSiteGrant.handler>[0]
    >({ ...principal(), params: { grantId } }),
  );

describe("browser site grants (database)", () => {
  test("a stored website approval is returned by a later read, keyed on its origin", async () => {
    const stored = await store("https://www.example.com/search?q=contract");
    expect(stored).toMatchObject({
      created: true,
      origin: "https://www.example.com",
    });
    const grants = await reload();
    expect(grants.map(({ origin }) => origin)).toEqual([
      "https://www.example.com",
    ]);
    expect(audits).toContainEqual(
      expect.objectContaining({
        metadata: { browserOrigin: "https://www.example.com", scope: "always" },
      }),
    );
  });

  test("storing the same site again keeps one grant", async () => {
    const first = await store("https://example.com/a");
    const second = await store("https://EXAMPLE.com:443/b");
    expect(second).toMatchObject({ created: false });
    if (first instanceof HttpStatusResponse) {
      panic("Expected the first grant to be stored");
    }
    expect(second).toMatchObject({ id: first.id });
    expect(await reload()).toHaveLength(1);
  });

  test("another port, scheme or subdomain is another site", async () => {
    await store("https://example.com/");
    await store("https://example.com:8443/");
    await store("https://docs.example.com/");
    expect((await reload()).map(({ origin }) => origin)).toEqual([
      "https://docs.example.com",
      "https://example.com",
      "https://example.com:8443",
    ]);
  });

  test("a site that is not HTTPS is refused and nothing is stored", async () => {
    for (const url of [
      "http://example.com/",
      "https://user:secret@example.com/",
      "not a url",
    ]) {
      expect(await store(url)).toMatchObject({ code: 422 });
    }
    expect(await reload()).toEqual([]);
  });

  test("a colleague's read does not return the member's grants", async () => {
    await store("https://example.com/");
    expect(await reload(ids.userA2)).toEqual([]);
  });

  test("a removed grant is gone on the next read", async () => {
    const stored = await store("https://example.com/");
    if (stored instanceof HttpStatusResponse) {
      panic("Expected the grant to be stored");
    }
    expect(await remove(stored.id)).toEqual({ deleted: true });
    expect(await reload()).toEqual([]);
    expect(await remove(stored.id)).toEqual({ deleted: false });
  });

  test("reads the same work for the member's grants whatever a colleague holds", async () => {
    const seedAt = async (size: number) =>
      await seedBrowserSiteGrantsScaling(testDb, {
        organizationId: ids.orgA,
        otherUserId: ids.userA2,
        userId: ids.userA1,
        size,
      });
    const small = await seedAt(10);
    try {
      const at10 = await browserSiteGrantsScalingScenario.measure(small);
      await small.cleanup();
      const large = await seedAt(200);
      try {
        const at200 = await browserSiteGrantsScalingScenario.measure(large);
        expect(at10.rows).toBe(BROWSER_SITE_GRANTS_PAGE);
        expect(at200.rows).toBe(BROWSER_SITE_GRANTS_PAGE);
        expect(readScalingViolations({ small: at10, large: at200 })).toEqual(
          [],
        );
      } finally {
        await large.cleanup();
      }
    } finally {
      await small.cleanup();
    }
  });
});
