import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import { rlsDb, rootDb } from "@/api/db/root";
import { accountAuditLogs, accountExports } from "@/api/db/schema";
import { createDownloadPersonalDataExport } from "@/api/handlers/account-exports/download";
import { organizationsRoute } from "@/api/handlers/organizations/routes";
import { routes } from "@/api/http/route";
import { ACCOUNT_EXPORT_LIMITS } from "@/api/lib/account-export/constants";
import { ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE } from "@/api/lib/account-export/organization-audit-gate";
import {
  countOrganizationAuditRows,
  requestOrganizationAuditExport,
} from "@/api/lib/account-export/store";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { getAuth } from "@/api/lib/auth";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import { completeOrganizationAuditExport } from "@/api/tests/helpers/organization-audit-export";
import type { CompletedOrganizationAuditExport } from "@/api/tests/helpers/organization-audit-export";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";

// timeout: real email-code sign-ins and organization writes on PGlite.
setDefaultTimeout(120_000);

// Archives the builder published, by object key, standing in for the bucket.
const publishedArchives = new Map<string, Uint8Array>();

const organizationServer = serveRoutesForTest(organizationsRoute);
const downloadServer = serveRoutesForTest(
  routes(
    {
      "/:exportId/download": {
        GET: createDownloadPersonalDataExport({
          openObjectStream: async (objectKey) => {
            const archive =
              publishedArchives.get(objectKey) ??
              panic("Download opened an archive that was never published");
            return {
              body: new Blob([archive]).stream(),
              contentLength: archive.byteLength,
            };
          },
        }),
      },
    },
    { prefix: "/me/data-exports" },
  ),
);

beforeAll(async () => {
  await initAgentAuthTestDb();
});
afterAll(async () => {
  await organizationServer.stop();
  await downloadServer.stop();
  await releaseAgentAuthTestDb();
});

const createOrganization = async (owner?: HumanBrowser) => {
  const browser =
    owner ??
    (await signInHuman(`audit-export-owner-${Bun.randomUUIDv7()}@stella.dev`));
  const created = await getAuth().api.createOrganization({
    body: {
      name: "Audit export",
      slug: `audit-export-${Bun.randomUUIDv7()}`,
    },
    headers: browser.headers(),
  });
  await browser.setActiveOrganization(created.id);
  return {
    owner: browser,
    ownerId: brandPersistedUserId(browser.userId),
    organizationId: brandPersistedOrganizationId(created.id),
  };
};

const exportAuditTrail = async ({
  ownerId,
  organizationId,
}: Awaited<
  ReturnType<typeof createOrganization>
>): Promise<CompletedOrganizationAuditExport> => {
  const completed = await completeOrganizationAuditExport({
    userId: ownerId,
    organizationId,
    db: rootDb,
    scopedDatabase: rlsDb,
  });
  publishedArchives.set(completed.objectKey, completed.archive);
  return completed;
};

const deleteOrganization = async (
  browser: HumanBrowser,
  organizationId: string,
) =>
  await getAuth().api.deleteOrganization({
    body: { organizationId },
    headers: browser.headers(),
    asResponse: true,
  });

const organizationExists = async (organizationId: string) =>
  (
    await rootDb
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, organizationId))
  ).length === 1;

const auditRowCount = async (
  organizationId: ReturnType<typeof brandPersistedOrganizationId>,
) =>
  await rootDb.transaction(
    async (tx) => await countOrganizationAuditRows(tx, organizationId),
  );

const archiveText = (archive: Uint8Array) =>
  // client-zip stores entries without compression, so names and rows read
  // straight off the archive bytes.
  new TextDecoder().decode(archive);

const auditExportRequest = async (
  browser: HumanBrowser,
  method: "GET" | "POST",
) =>
  await organizationServer.fetch(
    new Request("http://localhost/organizations/audit-export", {
      method,
      headers: { cookie: browser.cookieHeader() },
    }),
  );

describe("organization deletion requires an audit log archive", () => {
  test("deletion is refused while the owner holds no archive", async () => {
    const created = await createOrganization();
    const before = await auditRowCount(created.organizationId);

    const deletion = await deleteOrganization(
      created.owner,
      created.organizationId,
    );

    expect(deletion.status).toBe(409);
    expect(await deletion.json()).toMatchObject({
      code: ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE.required,
    });
    expect(await organizationExists(created.organizationId)).toBe(true);
    expect(await auditRowCount(created.organizationId)).toBe(before);
  });

  test("deletion is refused once the trail has entries the archive does not hold", async () => {
    const created = await createOrganization();
    const archived = await exportAuditTrail(created);
    await rootDb.transaction(
      async (tx) =>
        await createBackgroundAuditRecorder({
          organizationId: created.organizationId,
          workspaceId: null,
          userId: created.ownerId,
          execution: {
            performer: { type: "user", id: created.ownerId },
            trigger: { type: "direct" },
          },
        })(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: created.organizationId,
        }),
    );

    const deletion = await deleteOrganization(
      created.owner,
      created.organizationId,
    );

    expect(deletion.status).toBe(409);
    expect(await deletion.json()).toMatchObject({
      code: ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE.stale,
    });
    expect(await organizationExists(created.organizationId)).toBe(true);
    expect(await auditRowCount(created.organizationId)).toBe(
      archived.coverage.rowCount + 1,
    );

    // A new request replaces the outgrown archive, and the replacement holds
    // the newer entry, so the deletion then proceeds.
    const replacement = await exportAuditTrail(created);
    expect(replacement.exportId).not.toBe(archived.exportId);
    expect(replacement.coverage.rowCount).toBe(
      await auditRowCount(created.organizationId),
    );
    const retried = await deleteOrganization(
      created.owner,
      created.organizationId,
    );
    expect(retried.status, await retried.clone().text()).toBe(200);
  });

  test("a complete archive admits the deletion and stays downloadable by its owner", async () => {
    const created = await createOrganization();
    const archived = await exportAuditTrail(created);
    const latest = await auditExportRequest(created.owner, "GET");
    expect(await latest.json()).toMatchObject({
      latest: {
        id: archived.exportId,
        status: "ready",
        coversCurrentTrail: true,
      },
    });
    const liveRows = await auditRowCount(created.organizationId);
    expect(archived.coverage.rowCount).toBe(liveRows);
    expect(liveRows).toBeGreaterThan(0);
    const contents = archiveText(archived.archive);
    expect(contents).toContain("audit-logs.csv");
    expect(contents).toContain(
      "Time,User Name,User Email,Action,Resource Type,Resource ID,Changes,Changes Status",
    );
    expect(contents).toContain(`"auditRowCount":${String(liveRows)}`);

    const deletion = await deleteOrganization(
      created.owner,
      created.organizationId,
    );

    expect(deletion.status, await deletion.clone().text()).toBe(200);
    expect(await organizationExists(created.organizationId)).toBe(false);
    expect(await auditRowCount(created.organizationId)).toBe(0);
    const [retained] = await rootDb
      .select()
      .from(accountExports)
      .where(eq(accountExports.id, archived.exportId));
    expect(retained).toMatchObject({
      status: "ready",
      kind: "organization_audit",
      organizationId: created.organizationId,
      auditRowCount: liveRows,
    });
    // The deletion grants the archive a full retention window from now.
    expect((retained?.expiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      ACCOUNT_EXPORT_LIMITS.ttlMs - 5 * 60 * 1000,
    );

    const download = await downloadServer.fetch(
      new Request(
        `http://localhost/me/data-exports/${archived.exportId}/download`,
        { headers: { cookie: created.owner.cookieHeader() } },
      ),
    );
    expect(download.status, await download.clone().text()).toBe(200);
    expect(download.headers.get("content-disposition")).toContain(
      "organization-audit-log-",
    );
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(
      archived.archive,
    );
    expect(
      await rootDb
        .select({ eventType: accountAuditLogs.eventType })
        .from(accountAuditLogs)
        .where(
          and(
            eq(accountAuditLogs.userId, created.ownerId),
            eq(accountAuditLogs.resourceId, archived.exportId),
          ),
        ),
    ).toEqual(
      expect.arrayContaining([
        { eventType: "account.data_export.requested" },
        { eventType: "account.data_export.ready" },
        { eventType: "account.data_export.downloaded" },
      ]),
    );
  });

  test("a member who is not an owner can neither start nor download the archive", async () => {
    const created = await createOrganization();
    const admin = await signInHuman(
      `audit-export-admin-${Bun.randomUUIDv7()}@stella.dev`,
    );
    await getAuth().api.addMember({
      body: {
        organizationId: created.organizationId,
        userId: admin.userId,
        role: "admin",
      },
      headers: created.owner.headers(),
    });
    await admin.setActiveOrganization(created.organizationId);

    expect((await auditExportRequest(admin, "POST")).status).toBe(403);
    expect((await auditExportRequest(admin, "GET")).status).toBe(403);
    const direct = await requestOrganizationAuditExport({
      userId: brandPersistedUserId(admin.userId),
      organizationId: created.organizationId,
      db: rootDb,
    });
    expect(Result.isError(direct) ? direct.error.code : null).toBe(
      "organization_audit_export_forbidden",
    );
    expect(
      await rootDb
        .select({ id: accountExports.id })
        .from(accountExports)
        .where(eq(accountExports.userId, brandPersistedUserId(admin.userId))),
    ).toEqual([]);

    const archived = await exportAuditTrail(created);
    const download = await downloadServer.fetch(
      new Request(
        `http://localhost/me/data-exports/${archived.exportId}/download`,
        { headers: { cookie: admin.cookieHeader() } },
      ),
    );
    expect(download.status).toBe(404);
  });

  test("an archive of one organization never admits deleting another", async () => {
    const first = await createOrganization();
    const second = await createOrganization(first.owner);
    const archived = await exportAuditTrail(first);

    const deletion = await deleteOrganization(
      first.owner,
      second.organizationId,
    );

    expect(deletion.status).toBe(409);
    expect(await deletion.json()).toMatchObject({
      code: ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE.required,
    });
    expect(await organizationExists(second.organizationId)).toBe(true);
    const [untouched] = await rootDb
      .select({ status: accountExports.status })
      .from(accountExports)
      .where(eq(accountExports.id, archived.exportId));
    expect(untouched).toEqual({ status: "ready" });

    await first.owner.setActiveOrganization(first.organizationId);
    const ownDeletion = await deleteOrganization(
      first.owner,
      first.organizationId,
    );
    expect(ownDeletion.status, await ownDeletion.clone().text()).toBe(200);
  });
});
