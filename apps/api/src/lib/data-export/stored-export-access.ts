import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import type { PermissionInput } from "@stll/permissions";

import { member } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db-types";
import { organizationDataExports } from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole } from "@/api/lib/member-roles";
import { hasCurrentMemberPermission } from "@/api/lib/permission-authorization";
import { brandPersistedDataExportId } from "@/api/lib/safe-id-boundaries";
import { memberReachableMatterIds } from "@/api/lib/workspaces/authorized-workspace-ids";

/**
 * Who may read a stored organization data export.
 *
 * A stored export (its parts, manifest, part metadata and progress) holds the
 * contents of every matter it represents. It is readable, downloadable or
 * replayable only by a member who, right now, holds `dataExport:read` and
 * reaches every one of those matters. Both are checked live on every read
 * (get, list, download) and before every replay of a stored response, so
 * access lost after the export was planned or finished is lost for the
 * export too. A refusal writes nothing: it comes before any audit event or
 * request receipt, and it reads as not found.
 *
 * Every data export route goes through `readableStoredDataExports`; the
 * census in `stored-export-access.test.ts` keeps it that way.
 */

export const DATA_EXPORT_READ_PERMISSION = {
  dataExport: ["read"],
} satisfies PermissionInput;

/**
 * Every matter a stored export represents: the matters of its finished parts
 * and of its plan (the matters still to be packed). Selected next to the row,
 * so the check reads the same row the route answers with.
 */
export const dataExportMatterIdsSql = sql<string[]>`ARRAY(
  SELECT DISTINCT represented.matter_id
  FROM (
    SELECT pg_catalog.jsonb_array_elements_text(part->'matterIds') AS matter_id
    FROM pg_catalog.jsonb_array_elements(${organizationDataExports.parts}) AS part
    UNION ALL
    SELECT pg_catalog.jsonb_array_elements_text(part->'matterIds')
    FROM pg_catalog.jsonb_array_elements(
      COALESCE(${organizationDataExports.plan}->'parts', '[]'::jsonb)
    ) AS part
  ) AS represented
)`;

type StoredExport = { matterIds: readonly string[] };

type ReadableStoredDataExportsOptions<Row extends StoredExport> = {
  tx: Pick<Transaction, "select" | "execute">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  exports: readonly Row[];
};

/** The stored exports this member may read now, in the order given. */
export const readableStoredDataExports = async <Row extends StoredExport>({
  tx,
  organizationId,
  userId,
  exports,
}: ReadableStoredDataExportsOptions<Row>): Promise<Row[]> => {
  if (exports.length === 0) {
    return [];
  }
  const current = await tx
    .select({ role: member.role })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .limit(1);
  const role = current.at(0)?.role;
  if (
    role === undefined ||
    !isMemberRole(role) ||
    !hasCurrentMemberPermission(role, DATA_EXPORT_READ_PERMISSION)
  ) {
    return [];
  }
  const reachable = await memberReachableMatterIds(tx, {
    organizationId,
    userId,
    workspaceIds: exports.flatMap(({ matterIds }) => matterIds),
  });
  return exports.filter(({ matterIds }) =>
    matterIds.every((matterId) => reachable.has(matterId)),
  );
};

type StoredDataExportReadOptions = {
  tx: Pick<Transaction, "select" | "execute">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  exportId: SafeId<"dataExport">;
};

/**
 * Whether this member may read one stored export now. False for an export
 * that does not exist in the organization, so a refusal and an absent export
 * answer alike.
 */
export const canReadStoredDataExport = async ({
  tx,
  organizationId,
  userId,
  exportId,
}: StoredDataExportReadOptions): Promise<boolean> => {
  const rows = await tx
    .select({
      id: organizationDataExports.id,
      matterIds: dataExportMatterIdsSql,
    })
    .from(organizationDataExports)
    .where(
      and(
        eq(organizationDataExports.id, exportId),
        eq(organizationDataExports.organizationId, organizationId),
      ),
    )
    .limit(1);
  const readable = await readableStoredDataExports({
    tx,
    organizationId,
    userId,
    exports: rows,
  });
  return readable.length === 1;
};

type StoredDataExportRouteContext = {
  scopedDb: ScopedDb;
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user"> };
};

const DATA_EXPORT_NOT_FOUND = () =>
  new HandlerError({
    status: 404,
    code: "data_export_not_found",
    message: "Export not found",
  });

/**
 * A route's pre-replay authorization: the caller may read this stored export
 * now. Runs before the request receipt is claimed, so a refusal stores and
 * replays nothing.
 */
export const authorizeStoredDataExportRead = async (
  { scopedDb, session, user }: StoredDataExportRouteContext,
  exportId: SafeId<"dataExport">,
): Promise<Result<void, HandlerError>> =>
  (await scopedDb(
    async (tx) =>
      await canReadStoredDataExport({
        tx,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        exportId,
      }),
  ))
    ? Result.ok(undefined)
    : Result.err(DATA_EXPORT_NOT_FOUND());

const storedExportResponseSchema = v.object({
  export: v.object({ id: v.pipe(v.string(), v.uuid()) }),
});

/**
 * Before a stored response that names an export is replayed: the caller may
 * read that export now. A stored body without an export is refused.
 */
export const authorizeStoredDataExportReplay = async (
  context: StoredDataExportRouteContext,
  body: unknown,
): Promise<Result<void, HandlerError>> => {
  const stored = v.safeParse(storedExportResponseSchema, body);
  return stored.success
    ? await authorizeStoredDataExportRead(
        context,
        brandPersistedDataExportId(stored.output.export.id),
      )
    : Result.err(DATA_EXPORT_NOT_FOUND());
};
