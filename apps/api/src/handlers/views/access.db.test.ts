import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { user } from "@/api/db/auth-schema";
import { workspaceViews, workspaceViewTemplates } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import exportReport from "@/api/handlers/reports/views/export";
import createViewTemplate from "@/api/handlers/view-templates/create";
import deleteViewTemplate from "@/api/handlers/view-templates/delete";
import listViewTemplates from "@/api/handlers/view-templates/list";
import readNavigation from "@/api/handlers/workspaces/read-navigation";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { avtViewAccessStatus } from "@/api/lib/auth/feature-access/view-eligibility";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import type { ViewLayout } from "@/api/lib/views-schema";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import convertView from "./convert";
import createView from "./create";
import deleteView from "./delete";
import listViews from "./list";
import reorderViews from "./reorder";
import exportTableView from "./table/export";
import updateView from "./update";

setDefaultTimeout(120_000);
let testDb: TestDatabase;
let ids: TestIds;
const seededTemplateIds: SafeId<"workspaceViewTemplate">[] = [];
const seededIds: SafeId<"workspaceView">[] = [];
const layout = (type: "avt" | "filesystem"): ViewLayout =>
  type === "avt"
    ? {
        type,
        version: 1,
        listId: null,
        filters: [],
        sorts: [],
        hiddenProperties: [],
        calculations: [],
      }
    : {
        type,
        version: 1,
        filters: [],
        sorts: [],
        hiddenProperties: [],
        calculations: [],
      };

const seed = async (type: "avt" | "filesystem") => {
  const id = createSafeId<"workspaceView">();
  seededIds.push(id);
  await testDb.insert(workspaceViews).values({
    id,
    workspaceId: ids.wsA1,
    name: "View",
    layout: layout(type),
    position: 0,
  });
  return id;
};

const context = () => ({
  workspaceId: ids.wsA1,
  session: { activeOrganizationId: ids.orgA },
  user: { id: ids.userA1 },
  safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
});

const withAccess = async <T>(
  status: "available" | "unavailable" | "colleague",
  run: () => Promise<T>,
) => {
  const restoreRuntime = setRuntimeModeForTesting({
    mode: RUNTIME_MODE.strict,
  });
  const previous = env.API_FEATURE_ACCESS_GRANTS;
  const previousDeployment = env.FEATURE_LEGAL_LISTS;
  env.FEATURE_LEGAL_LISTS = true;
  const grantsByStatus = {
    available: {
      "list-verification": [{ type: "organization", organizationId: ids.orgA }],
    },
    unavailable: {},
    colleague: {
      "list-verification": [
        {
          type: "member",
          organizationId: ids.orgA,
          email: `${ids.userA2}@example.test`,
        },
      ],
    },
  } satisfies Record<typeof status, FeatureAccessGrants>;
  env.API_FEATURE_ACCESS_GRANTS = grantsByStatus[status];
  try {
    const resolved = await context().safeDb(
      async (tx) =>
        await resolveFeatureAccessSnapshot({
          tx,
          organizationId: ids.orgA,
          userId: ids.userA1,
        }),
    );
    if (resolved.isErr()) {
      throw resolved.error;
    }
    expect(
      avtViewAccessStatus({
        snapshot: resolved.value,
        organizationId: ids.orgA,
        userId: ids.userA1,
      }),
    ).toBe(status === "available" ? "available" : "unavailable");
    return await run();
  } finally {
    restoreRuntime();
    env.API_FEATURE_ACCESS_GRANTS = previous;
    env.FEATURE_LEGAL_LISTS = previousDeployment;
  }
};

const expectNotFound = (result: unknown) => {
  expect(result).toBeInstanceOf(ElysiaCustomStatusResponse);
  if (result instanceof ElysiaCustomStatusResponse) {
    expect(result.code).toBe(404);
    expect(result.response).toEqual({ message: "Not found" });
  }
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await testDb
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
});
afterAll(async () => {
  try {
    if (seededTemplateIds.length > 0) {
      await testDb
        .delete(workspaceViewTemplates)
        .where(inArray(workspaceViewTemplates.id, seededTemplateIds));
    }
    if (seededIds.length > 0) {
      await testDb
        .delete(workspaceViews)
        .where(inArray(workspaceViews.id, seededIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("AVT views follow the current access grant", () => {
  test("denies proposed AVT creation without inserting a view", async () => {
    const id = createSafeId<"workspaceView">();
    const result = await withAccess(
      "unavailable",
      async () =>
        await createView.handler(
          createTestHandlerContext<Parameters<typeof createView.handler>[0]>({
            ...context(),
            body: { id, name: "View", layout: layout("avt") },
          }),
        ),
    );
    expectNotFound(result);
    expect(
      await testDb
        .select({ id: workspaceViews.id })
        .from(workspaceViews)
        .where(eq(workspaceViews.id, id)),
    ).toEqual([]);
  });

  test("denies renaming and converting a persisted AVT view", async () => {
    const viewId = await seed("avt");
    await withAccess("unavailable", async () => {
      expectNotFound(
        await updateView.handler(
          createTestHandlerContext<Parameters<typeof updateView.handler>[0]>({
            ...context(),
            params: { workspaceId: ids.wsA1, viewId },
            body: { name: "Renamed" },
          }),
        ),
      );
      expectNotFound(
        await convertView.handler(
          createTestHandlerContext<Parameters<typeof convertView.handler>[0]>({
            ...context(),
            params: { workspaceId: ids.wsA1, viewId },
            body: { targetType: "filesystem" },
          }),
        ),
      );
    });
    const stored = await testDb.query.workspaceViews.findFirst({
      where: { id: { eq: viewId } },
    });
    expect(stored?.name).toBe("View");
    expect(stored?.layout.type).toBe("avt");
  });

  test("denies converting an ordinary view to AVT", async () => {
    const viewId = await seed("filesystem");
    expectNotFound(
      await withAccess(
        "unavailable",
        async () =>
          await convertView.handler(
            createTestHandlerContext<Parameters<typeof convertView.handler>[0]>(
              {
                ...context(),
                params: { workspaceId: ids.wsA1, viewId },
                body: { targetType: "avt" },
              },
            ),
          ),
      ),
    );
    const stored = await testDb.query.workspaceViews.findFirst({
      where: { id: { eq: viewId } },
    });
    expect(stored?.layout.type).toBe("filesystem");
  });

  test("retains unavailable view identities without layout details", async () => {
    const avtId = await seed("avt");
    const ordinaryId = await seed("filesystem");
    const read = async () =>
      await listViews.handler(
        createTestHandlerContext<Parameters<typeof listViews.handler>[0]>(
          context(),
        ),
      );
    const denied = await withAccess("unavailable", read);
    expect(Array.isArray(denied)).toBe(true);
    if (Array.isArray(denied)) {
      expect(denied.find((view) => view.id === avtId)).toEqual({
        id: avtId,
        layout: { type: "avt" },
        eligibility: "unavailable",
      });
      expect(denied.some((view) => view.id === ordinaryId)).toBe(true);
    }
    const granted = await withAccess("available", read);
    expect(Array.isArray(granted)).toBe(true);
    if (Array.isArray(granted)) {
      expect(granted.find((view) => view.id === avtId)).toMatchObject({
        id: avtId,
        name: "View",
        layout: layout("avt"),
      });
    }
  });

  test("allows creating, renaming and converting AVT with a current grant", async () => {
    await withAccess("available", async () => {
      const newViewId = createSafeId<"workspaceView">();
      seededIds.push(newViewId);
      expect(
        await createView.handler(
          createTestHandlerContext<Parameters<typeof createView.handler>[0]>({
            ...context(),
            body: { id: newViewId, name: "View", layout: layout("avt") },
          }),
        ),
      ).not.toBeInstanceOf(ElysiaCustomStatusResponse);
      const templateName = createSafeId<"workspaceViewTemplate">();
      const template = await createViewTemplate.handler(
        createTestHandlerContext<
          Parameters<typeof createViewTemplate.handler>[0]
        >({
          ...context(),
          body: { name: templateName, layout: layout("avt") },
        }),
      );
      expect(template).not.toBeInstanceOf(ElysiaCustomStatusResponse);
      if (!(template instanceof ElysiaCustomStatusResponse)) {
        seededTemplateIds.push(template.id);
        expect(
          await deleteViewTemplate.handler(
            createTestHandlerContext<
              Parameters<typeof deleteViewTemplate.handler>[0]
            >({
              ...context(),
              params: { workspaceId: ids.wsA1, templateId: template.id },
            }),
          ),
        ).not.toBeInstanceOf(ElysiaCustomStatusResponse);
      }
      const tableExport = await exportTableView.handler(
        createTestHandlerContext<Parameters<typeof exportTableView.handler>[0]>(
          {
            ...context(),
            params: { workspaceId: ids.wsA1, viewId: newViewId },
            query: { format: "csv" },
          },
        ),
      );
      expect(tableExport).toBeInstanceOf(ElysiaCustomStatusResponse);
      if (tableExport instanceof ElysiaCustomStatusResponse) {
        expect(tableExport.code).toBe(400);
      }
      const id = createSafeId<"workspaceView">();
      seededIds.push(id);
      const created = await createView.handler(
        createTestHandlerContext<Parameters<typeof createView.handler>[0]>({
          ...context(),
          body: { id, name: "View", layout: layout("avt") },
        }),
      );
      expect(created).not.toBeInstanceOf(ElysiaCustomStatusResponse);
      const renamed = await updateView.handler(
        createTestHandlerContext<Parameters<typeof updateView.handler>[0]>({
          ...context(),
          params: { workspaceId: ids.wsA1, viewId: id },
          body: { name: "Renamed" },
        }),
      );
      expect(renamed).toEqual({});
      const converted = await convertView.handler(
        createTestHandlerContext<Parameters<typeof convertView.handler>[0]>({
          ...context(),
          params: { workspaceId: ids.wsA1, viewId: id },
          body: { targetType: "filesystem" },
        }),
      );
      expect(converted).not.toBeInstanceOf(ElysiaCustomStatusResponse);
      const stored = await testDb.query.workspaceViews.findFirst({
        where: { id: { eq: id } },
      });
      expect(stored?.name).toBe("Renamed");
      expect(stored?.layout.type).toBe("filesystem");
    });
  });
  test("denies AVT table exports before preparing a file", async () => {
    const viewId = await seed("avt");
    expectNotFound(
      await withAccess(
        "unavailable",
        async () =>
          await exportTableView.handler(
            createTestHandlerContext<
              Parameters<typeof exportTableView.handler>[0]
            >({
              ...context(),
              params: { workspaceId: ids.wsA1, viewId },
              query: { format: "csv" },
            }),
          ),
      ),
    );
  });

  test("projects personal AVT templates according to the current grant", async () => {
    const templateId = createSafeId<"workspaceViewTemplate">();
    seededTemplateIds.push(templateId);
    await testDb.insert(workspaceViewTemplates).values({
      id: templateId,
      organizationId: ids.orgA,
      userId: ids.userA1,
      name: templateId,
      layout: layout("avt"),
    });
    const read = async () =>
      await listViewTemplates.handler(
        createTestHandlerContext<
          Parameters<typeof listViewTemplates.handler>[0]
        >(context()),
      );
    const denied = await withAccess("unavailable", read);
    expect(Array.isArray(denied)).toBe(true);
    if (Array.isArray(denied)) {
      expect(denied.some((template) => template.id === templateId)).toBe(false);
    }
    const granted = await withAccess("available", read);
    expect(Array.isArray(granted)).toBe(true);
    if (Array.isArray(granted)) {
      expect(granted.some((template) => template.id === templateId)).toBe(true);
    }
    expectNotFound(
      await withAccess(
        "unavailable",
        async () =>
          await createViewTemplate.handler(
            createTestHandlerContext<
              Parameters<typeof createViewTemplate.handler>[0]
            >({
              ...context(),
              body: { name: "Template", layout: layout("avt") },
            }),
          ),
      ),
    );
  });
});

test.each(["unavailable", "colleague"] as const)(
  "%s denies AVT controls and retains ordinary discovery",
  async (status) => {
    const viewId = await seed("avt");
    const ordinaryId = await seed("filesystem");
    const templateId = createSafeId<"workspaceViewTemplate">();
    seededTemplateIds.push(templateId);
    await testDb.insert(workspaceViewTemplates).values({
      id: templateId,
      organizationId: ids.orgA,
      userId: ids.userA1,
      name: templateId,
      layout: layout("avt"),
    });
    await withAccess(status, async () => {
      const newId = createSafeId<"workspaceView">();
      expectNotFound(
        await createView.handler(
          createTestHandlerContext<Parameters<typeof createView.handler>[0]>({
            ...context(),
            body: { id: newId, name: "View", layout: layout("avt") },
          }),
        ),
      );
      expectNotFound(
        await updateView.handler(
          createTestHandlerContext<Parameters<typeof updateView.handler>[0]>({
            ...context(),
            params: { workspaceId: ids.wsA1, viewId },
            body: { name: "Renamed" },
          }),
        ),
      );
      expectNotFound(
        await convertView.handler(
          createTestHandlerContext<Parameters<typeof convertView.handler>[0]>({
            ...context(),
            params: { workspaceId: ids.wsA1, viewId },
            body: { targetType: "filesystem" },
          }),
        ),
      );
      expectNotFound(
        await exportTableView.handler(
          createTestHandlerContext<
            Parameters<typeof exportTableView.handler>[0]
          >({
            ...context(),
            params: { workspaceId: ids.wsA1, viewId },
            query: { format: "csv" },
          }),
        ),
      );
      expectNotFound(
        await createViewTemplate.handler(
          createTestHandlerContext<
            Parameters<typeof createViewTemplate.handler>[0]
          >({ ...context(), body: { name: "View", layout: layout("avt") } }),
        ),
      );
      const templates = await listViewTemplates.handler(
        createTestHandlerContext<
          Parameters<typeof listViewTemplates.handler>[0]
        >(context()),
      );
      expect(
        Array.isArray(templates) &&
          templates.some((row) => row.id === templateId),
      ).toBe(false);
      expectNotFound(
        await deleteView.handler(
          createTestHandlerContext<Parameters<typeof deleteView.handler>[0]>({
            ...context(),
            params: { workspaceId: ids.wsA1, viewId },
          }),
        ),
      );
      expectNotFound(
        await reorderViews.handler(
          createTestHandlerContext<Parameters<typeof reorderViews.handler>[0]>({
            ...context(),
            body: { viewIds: [viewId, ordinaryId] },
          }),
        ),
      );
      expectNotFound(
        await deleteViewTemplate.handler(
          createTestHandlerContext<
            Parameters<typeof deleteViewTemplate.handler>[0]
          >({ ...context(), params: { workspaceId: ids.wsA1, templateId } }),
        ),
      );
      expectNotFound(
        await exportReport.handler(
          createTestHandlerContext<Parameters<typeof exportReport.handler>[0]>({
            ...context(),
            body: {
              viewId,
              mode: "download",
              aiNarrative: false,
              templateRef: { type: "builtin", key: "summary" },
            },
          }),
        ),
      );
      const views = await listViews.handler(
        createTestHandlerContext<Parameters<typeof listViews.handler>[0]>(
          context(),
        ),
      );
      expect(
        Array.isArray(views) && views.find((view) => view.id === viewId),
      ).toEqual({
        id: viewId,
        layout: { type: "avt" },
        eligibility: "unavailable",
      });
      expect(
        Array.isArray(views) && views.some((view) => view.id === ordinaryId),
      ).toBe(true);
    });
    expect(
      (
        await testDb.query.workspaceViews.findFirst({
          where: { id: { eq: viewId } },
        })
      )?.layout.type,
    ).toBe("avt");
    expect(
      await testDb.query.workspaceViewTemplates.findFirst({
        where: { id: { eq: templateId } },
      }),
    ).toBeDefined();
  },
);

test("granted AVT targets support rename, conversion and dedicated controls", async () => {
  const viewId = await seed("avt");
  await withAccess("available", async () => {
    const renamed = await updateView.handler(
      createTestHandlerContext<Parameters<typeof updateView.handler>[0]>({
        ...context(),
        params: { workspaceId: ids.wsA1, viewId },
        body: { name: "Granted view" },
      }),
    );
    expect(renamed).not.toBeInstanceOf(ElysiaCustomStatusResponse);
    const converted = await convertView.handler(
      createTestHandlerContext<Parameters<typeof convertView.handler>[0]>({
        ...context(),
        params: { workspaceId: ids.wsA1, viewId },
        body: { targetType: "filesystem" },
      }),
    );
    expect(converted).not.toBeInstanceOf(ElysiaCustomStatusResponse);
    expect(
      await convertView.handler(
        createTestHandlerContext<Parameters<typeof convertView.handler>[0]>({
          ...context(),
          params: { workspaceId: ids.wsA1, viewId },
          body: { targetType: "avt" },
        }),
      ),
    ).not.toBeInstanceOf(ElysiaCustomStatusResponse);
    const report = await exportReport.handler(
      createTestHandlerContext<Parameters<typeof exportReport.handler>[0]>({
        ...context(),
        body: {
          viewId,
          mode: "download",
          aiNarrative: false,
          templateRef: { type: "builtin", key: "summary" },
        },
      }),
    );
    expect(report).toBeInstanceOf(ElysiaCustomStatusResponse);
    if (report instanceof ElysiaCustomStatusResponse) {
      expect(report.code).toBe(400);
    }
    const viewIds = (
      await testDb
        .select({ id: workspaceViews.id })
        .from(workspaceViews)
        .where(eq(workspaceViews.workspaceId, ids.wsA1))
    ).map((row) => row.id);
    expect(
      await reorderViews.handler(
        createTestHandlerContext<Parameters<typeof reorderViews.handler>[0]>({
          ...context(),
          body: { viewIds },
        }),
      ),
    ).not.toBeInstanceOf(ElysiaCustomStatusResponse);
    expect(
      await deleteView.handler(
        createTestHandlerContext<Parameters<typeof deleteView.handler>[0]>({
          ...context(),
          params: { workspaceId: ids.wsA1, viewId },
        }),
      ),
    ).not.toBeInstanceOf(ElysiaCustomStatusResponse);
  });
});

test.each(["unavailable", "colleague", "available"] as const)(
  "%s navigation selects the first permitted view",
  async (status) => {
    const viewId = await seed("avt");
    const ordinaryId = await seed("filesystem");
    await testDb
      .update(workspaceViews)
      .set({ position: -2 })
      .where(eq(workspaceViews.id, viewId));
    await testDb
      .update(workspaceViews)
      .set({ position: -1 })
      .where(eq(workspaceViews.id, ordinaryId));
    const result = await withAccess(
      status,
      async () =>
        await readNavigation.handler(
          createTestHandlerContext<
            Parameters<typeof readNavigation.handler>[0]
          >({ ...context(), query: {} }),
        ),
    );
    expect(result).not.toBeInstanceOf(ElysiaCustomStatusResponse);
    if (!(result instanceof ElysiaCustomStatusResponse)) {
      expect(
        result.items.find((row) => row.id === ids.wsA1)?.defaultViewId,
      ).toBe(status === "available" ? viewId : ordinaryId);
    }
    await testDb
      .update(workspaceViews)
      .set({ position: 0 })
      .where(inArray(workspaceViews.id, [viewId, ordinaryId]));
  },
);

test("deployment availability remains a ceiling for granted AVT controls", async () => {
  const viewId = await seed("avt");
  const ordinaryId = await seed("filesystem");
  const templateId = createSafeId<"workspaceViewTemplate">();
  seededTemplateIds.push(templateId);
  await testDb.insert(workspaceViewTemplates).values({
    id: templateId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    name: templateId,
    layout: layout("avt"),
  });
  await withAccess("available", async () => {
    env.FEATURE_LEGAL_LISTS = false;
    expectNotFound(
      await deleteView.handler(
        createTestHandlerContext<Parameters<typeof deleteView.handler>[0]>({
          ...context(),
          params: { workspaceId: ids.wsA1, viewId },
        }),
      ),
    );
    expectNotFound(
      await reorderViews.handler(
        createTestHandlerContext<Parameters<typeof reorderViews.handler>[0]>({
          ...context(),
          body: { viewIds: [viewId, ordinaryId] },
        }),
      ),
    );
    expectNotFound(
      await deleteViewTemplate.handler(
        createTestHandlerContext<
          Parameters<typeof deleteViewTemplate.handler>[0]
        >({ ...context(), params: { workspaceId: ids.wsA1, templateId } }),
      ),
    );
    const views = await listViews.handler(
      createTestHandlerContext<Parameters<typeof listViews.handler>[0]>(
        context(),
      ),
    );
    expect(
      Array.isArray(views) && views.find((view) => view.id === viewId),
    ).toEqual({
      id: viewId,
      layout: { type: "avt" },
      eligibility: "unavailable",
    });
    expect(
      Array.isArray(views) && views.some((view) => view.id === ordinaryId),
    ).toBe(true);
  });
});
