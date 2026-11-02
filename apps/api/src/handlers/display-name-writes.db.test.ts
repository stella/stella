/**
 * A name saved through a route's own body schema is stored without explicit
 * directional formatting: the request is parsed the way the HTTP layer parses
 * it, the real handler runs against the test database, and the row is read
 * back.
 */

import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import "@/api/tests/setup-env";

import { apiRoutes } from "@/api/api-routes";
import type { SafeDb } from "@/api/db/safe-db";
import { contacts, workspaces, workspaceViews } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { updateContactHandler } from "@/api/handlers/contacts/update";
import type { UpdateContactHandlerProps } from "@/api/handlers/contacts/update";
import createView from "@/api/handlers/views/create";
import { updateWorkspaceHandler } from "@/api/handlers/workspaces/update";
import type { UpdateWorkspaceHandlerProps } from "@/api/handlers/workspaces/update";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { isValibotSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { getDefaultViews } from "@/api/lib/views";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

type CreateViewContext = Parameters<typeof createView.handler>[0];

const OVERRIDE = "\u202E";
const ISOLATE = "\u2066";
const POP_ISOLATE = "\u2069";

let testDb: TestDatabase;
let ids: TestIds;
let workspaceId: SafeId<"workspace">;

/** The body exactly as the live route accepts it. */
const parseRouteBody = (
  method: string,
  path: ApiRoutePath,
  raw: unknown,
): unknown => {
  const route = apiRoutes.find(
    (entry) => entry.method === method && entry.path === path,
  );
  const schema = route?.definition.config.body;
  if (!isValibotSchema(schema)) {
    throw new Error(`${method} ${path} declares no body schema`);
  }
  return v.parse(schema, raw);
};

const safeDb = (): SafeDb =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [workspaceId], ids.orgA, ids.userA1));

// timeout: booting the full PGlite schema can exceed the default hook budget.
beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  workspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId: ids.orgA,
    clientId: ids.contactA,
    name: "Lease review",
    reference: "REF-NAME-FORMATTING",
  });
}, 60_000);

afterAll(async () => {
  await releaseTestDb();
});

describe("names saved with directional controls", () => {
  test("a matter rename stores the name in the order it was typed", async () => {
    const body = parseRouteBody("POST", "/v1/workspaces/:workspaceId", {
      name: `Lease ${OVERRIDE}fdp.exe`,
    });
    const result = await Result.gen(() =>
      updateWorkspaceHandler({
        safeDb: safeDb(),
        organizationId: ids.orgA,
        workspaceId,
        recordAuditEvent: async () => undefined,
        body: asTestRaw<UpdateWorkspaceHandlerProps["body"]>(body),
      }),
    );
    expect(result.isOk()).toBe(true);

    const [row] = await testDb
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(row?.name).toBe("Lease fdp.exe");
  });

  test("a contact update stores every name part without the controls", async () => {
    const body = parseRouteBody("POST", "/v1/contacts/:contactId", {
      displayName: `Jana ${OVERRIDE}kcab`,
      firstName: `${ISOLATE}Jana${POP_ISOLATE}`,
      lastName: `${OVERRIDE}kcab`,
    });
    const result = await Result.gen(() =>
      updateContactHandler({
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
        ),
        organizationId: ids.orgA,
        contactId: ids.contactA,
        recordAuditEvent: async () => undefined,
        body: asTestRaw<UpdateContactHandlerProps["body"]>(body),
      }),
    );
    expect(result.isOk()).toBe(true);

    const [row] = await testDb
      .select({
        displayName: contacts.displayName,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
      })
      .from(contacts)
      .where(eq(contacts.id, ids.contactA));
    expect(row).toEqual({
      displayName: "Jana kcab",
      firstName: "Jana",
      lastName: "kcab",
    });
  });

  test("a new view stores its name without the controls", async () => {
    const table = getDefaultViews("en").find(
      (view) => view.layout.type === "table",
    );
    if (!table) {
      throw new Error("default views carry no table view");
    }
    const viewId = createSafeId<"workspaceView">();
    const body = parseRouteBody("PUT", "/v1/views/:workspaceId", {
      id: viewId,
      name: `Preset ${OVERRIDE}gnp.js`,
      layout: table.layout,
    });
    const context = asTestRaw<CreateViewContext>({
      body,
      createAuditRecorder: () => async () => undefined,
      memberRole: sessionMemberRole("owner"),
      recordAuditEvent: async () => undefined,
      request: new Request(`https://example.test/views/${workspaceId}`),
      route: "/v1/views/:workspaceId" satisfies ApiRoutePath,
      safeDb: safeDb(),
      scopedDb: createScopedDb(testDb, [workspaceId], ids.orgA, ids.userA1),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      workspaceId,
    });
    await createView.handler(context);

    const [row] = await testDb
      .select({ name: workspaceViews.name })
      .from(workspaceViews)
      .where(eq(workspaceViews.id, viewId));
    expect(row?.name).toBe("Preset gnp.js");
  });

  test("a name of directional controls alone is refused", () => {
    expect(() =>
      parseRouteBody("POST", "/v1/workspaces/:workspaceId", {
        name: `${OVERRIDE}${POP_ISOLATE}`,
      }),
    ).toThrow(v.ValiError);
  });
});
