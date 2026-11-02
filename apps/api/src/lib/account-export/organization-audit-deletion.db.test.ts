import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { ACCOUNT_EXPORT_SCOPES } from "@stll/api-contract";

import { member, organization } from "@/api/db/auth-schema";
import { WORKSPACE_ACCESS_MODE } from "@/api/db/rls";
import { rlsDb, rootDb } from "@/api/db/root";
import {
  accountAuditLogs,
  accountExports,
  auditLogs,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createDownloadPersonalDataExport } from "@/api/handlers/account-exports/download";
import { toAuditLogConditions } from "@/api/handlers/audit-logs/query";
import { organizationsRoute } from "@/api/handlers/organizations/routes";
import { routes } from "@/api/http/route";
import { ACCOUNT_EXPORT_LIMITS } from "@/api/lib/account-export/constants";
import { ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE } from "@/api/lib/account-export/organization-audit-gate";
import {
  countOrganizationAuditRows,
  readAccountExport,
  requestOrganizationAuditExport,
} from "@/api/lib/account-export/store";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { AUDIT_LOG_MATTER_WITHHELD_STATUS } from "@/api/lib/audit-log-export";
import { getAuth } from "@/api/lib/auth";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
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
const publishedArchives = new Map<string, Uint8Array<ArrayBuffer>>();

const openPublishedArchive = async (objectKey: string) => {
  const archive =
    publishedArchives.get(objectKey) ??
    panic("Download opened an archive that was never published");
  return {
    body: new Blob([archive]).stream(),
    contentLength: archive.byteLength,
  };
};

// The OAuth client this suite stands for holds account-export read consent
// for whichever account it names in its bearer token.
const OAUTH_TOKEN_PREFIX = "user:";

const organizationServer = serveRoutesForTest(organizationsRoute);
const downloadServer = serveRoutesForTest(
  routes(
    {
      "/:exportId/download": {
        GET: createDownloadPersonalDataExport({
          openObjectStream: openPublishedArchive,
          authenticateOAuth: async (token) =>
            Result.ok({
              userId: token.slice(OAUTH_TOKEN_PREFIX.length),
              organizationId: "organization",
              scopes: [ACCOUNT_EXPORT_SCOPES.read],
              credential: { type: "oauth_client" as const, clientId: "cli" },
            }),
          resolveOAuthUser: async (userId) => ({
            id: userId,
            email: `${userId}@example.test`,
          }),
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

const downloadArchive = async (
  browser: HumanBrowser,
  exportId: string,
  credential: "browser_session" | "oauth" = "browser_session",
) =>
  await downloadServer.fetch(
    new Request(`http://localhost/me/data-exports/${exportId}/download`, {
      headers:
        credential === "browser_session"
          ? { cookie: browser.cookieHeader() }
          : { authorization: `Bearer ${OAUTH_TOKEN_PREFIX}${browser.userId}` },
    }),
  );

/** Export and take the archive, as the danger zone leads an owner to. */
const exportAndDownload = async (
  created: Awaited<ReturnType<typeof createOrganization>>,
) => {
  const archived = await exportAuditTrail(created);
  const download = await downloadArchive(created.owner, archived.exportId);
  expect(download.status, await download.clone().text()).toBe(200);
  return archived;
};

const recordAuditEntry = async (
  created: Awaited<ReturnType<typeof createOrganization>>,
  workspaceId: SafeId<"workspace"> | null,
  resourceId: string,
) => {
  await rootDb.transaction(
    async (tx) =>
      await createBackgroundAuditRecorder({
        organizationId: created.organizationId,
        workspaceId,
        userId: created.ownerId,
        execution: {
          performer: { type: "user", id: created.ownerId },
          trigger: { type: "direct" },
        },
      })(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
        resourceId,
      }),
  );
};

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
    const archived = await exportAndDownload(created);
    await recordAuditEntry(created, null, created.organizationId);

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
    const replacement = await exportAndDownload(created);
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

    // The archive is complete, but the owner has not taken it yet.
    const undownloaded = await deleteOrganization(
      created.owner,
      created.organizationId,
    );
    expect(undownloaded.status).toBe(409);
    expect(await undownloaded.json()).toMatchObject({
      code: ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE.notDownloaded,
    });
    expect(await organizationExists(created.organizationId)).toBe(true);
    const taken = await downloadArchive(created.owner, archived.exportId);
    expect(taken.status, await taken.clone().text()).toBe(200);
    expect(
      await (await auditExportRequest(created.owner, "GET")).json(),
    ).toMatchObject({ latest: { status: "ready", downloaded: true } });

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

    const download = await downloadArchive(created.owner, archived.exportId);
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
    expect((await downloadArchive(admin, archived.exportId)).status).toBe(404);
  });

  test("an archive of one organization never admits deleting another", async () => {
    const first = await createOrganization();
    const second = await createOrganization(first.owner);
    const archived = await exportAndDownload(first);

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

  test("matters the owner cannot open stay in the archive with their details withheld", async () => {
    const created = await createOrganization();
    // A matter no member was added to: the owner's activity log does not
    // show it either.
    const personalMatterId = toSafeId<"workspace">(Bun.randomUUIDv7());
    await rootDb.insert(workspaces).values({
      id: personalMatterId,
      organizationId: created.organizationId,
      name: "Personal matter",
      reference: personalMatterId,
      status: "active",
    });
    const withheldResource = `withheld-${Bun.randomUUIDv7()}`;
    await recordAuditEntry(created, personalMatterId, withheldResource);
    await recordAuditEntry(created, personalMatterId, withheldResource);

    const archived = await exportAuditTrail(created);

    const liveRows = await auditRowCount(created.organizationId);
    expect(archived.coverage.rowCount).toBe(liveRows);
    const contents = archiveText(archived.archive);
    expect(contents).not.toContain(withheldResource);
    const withheldLines =
      contents.split(`,${AUDIT_LOG_MATTER_WITHHELD_STATUS}`).length - 1;
    expect(withheldLines).toBe(2);
    // The activity log export filters on the same rule the archive withholds
    // on, so what it shows the owner is exactly what the archive keeps whole.
    const visibleToActivityLog = await createScopedDb(
      rlsDb,
      {
        type: WORKSPACE_ACCESS_MODE.membership,
        serverValidatedWorkspaceIds: [],
      },
      created.organizationId,
      created.ownerId,
    )(async (tx) => {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(
          and(
            ...toAuditLogConditions({
              organizationId: created.organizationId,
              filter: {},
            }),
          ),
        );
      return row?.count ?? panic("Count returned no row");
    });
    expect(visibleToActivityLog).toBe(liveRows - withheldLines);
  });

  test("an OAuth client never reads an organization audit archive", async () => {
    const created = await createOrganization();
    const archived = await exportAuditTrail(created);

    expect(
      (await downloadArchive(created.owner, archived.exportId, "oauth")).status,
    ).toBe(404);
    expect(
      await readAccountExport({
        id: archived.exportId,
        userId: created.ownerId,
        reader: "delegated",
        db: rootDb,
      }),
    ).toBeNull();
    expect(
      (
        await readAccountExport({
          id: archived.exportId,
          userId: created.ownerId,
          reader: "browser_session",
          db: rootDb,
        })
      )?.id,
    ).toBe(archived.exportId);
    // Refused downloads leave the archive untaken.
    const [row] = await rootDb
      .select({ downloadedAt: accountExports.downloadedAt })
      .from(accountExports)
      .where(eq(accountExports.id, archived.exportId));
    expect(row).toEqual({ downloadedAt: null });
  });

  test("an owner demoted while the organization exists can no longer take its archive", async () => {
    const created = await createOrganization();
    const successor = await signInHuman(
      `audit-export-successor-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const added = await getAuth().api.addMember({
      body: {
        organizationId: created.organizationId,
        userId: successor.userId,
        role: "owner",
      },
      headers: created.owner.headers(),
    });
    expect(added).toBeDefined();
    await successor.setActiveOrganization(created.organizationId);
    const archived = await exportAuditTrail(created);
    const [previous] = await rootDb
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, created.organizationId),
          eq(member.userId, created.ownerId),
        ),
      );
    const demotion = await getAuth().api.updateMemberRole({
      body: {
        organizationId: created.organizationId,
        memberId: previous?.id ?? panic("The first owner is a member"),
        role: "admin",
      },
      headers: successor.headers(),
      asResponse: true,
    });
    expect(demotion.status, await demotion.clone().text()).toBe(200);

    expect(
      (await downloadArchive(created.owner, archived.exportId)).status,
    ).toBe(404);
  });

  test("only the deletion owner deletes an organization row", async () => {
    const created = await createOrganization();

    const raw = await Result.tryPromise(
      async () =>
        await rootDb
          .delete(organization)
          .where(eq(organization.id, created.organizationId)),
    );

    expect(Result.isError(raw)).toBe(true);
    expect(await organizationExists(created.organizationId)).toBe(true);
    // The owner path deletes it once its precondition holds.
    await exportAndDownload(created);
    const deletion = await deleteOrganization(
      created.owner,
      created.organizationId,
    );
    expect(deletion.status, await deletion.clone().text()).toBe(200);
    expect(await organizationExists(created.organizationId)).toBe(false);
  });
});
