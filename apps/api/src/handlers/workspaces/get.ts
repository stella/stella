import { Result } from "better-result";
import { sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { entityVersions } from "@/api/db/schema";
import { status } from "@/api/http/status";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";

type ReadWorkspaceHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
};

// The organization is part of the lookup, not a check after it. Callers reach
// this handler through an access gate that already resolved `workspaceId`
// inside the caller's organization, and `scopedDb` re-derives that
// authorization in RLS — but this helper is exported, and a caller holding a
// broader scope would otherwise read another tenant's row. Constraining the
// query means a mismatch returns no row, which the not-found path below
// already answers; there is no ownership decision left to make afterwards.
export const readWorkspaceHandler = async ({
  scopedDb,
  workspaceId,
  organizationId,
}: ReadWorkspaceHandlerProps) => {
  const result = await scopedDb((tx) =>
    tx.query.workspaces.findFirst({
      where: {
        id: { eq: workspaceId },
        organizationId: { eq: organizationId },
      },
      // How many live versions already carry a frozen stamp. Changing the
      // matter's reference cannot rewrite them, so the client warns with this
      // number before the edit. Correlated rather than a second statement:
      // this is one of the hottest reads in the app and it has a per-request
      // query budget. `entity_versions_workspace_id_idx` bounds the scan to
      // one matter's versions.
      extras: {
        stampedVersionCount: (table) => sql<number>`(
          SELECT count(*)::int
          FROM ${entityVersions}
          WHERE ${entityVersions.workspaceId} = ${table.id}
            AND ${entityVersions.stamp} IS NOT NULL
            AND substring(${entityVersions.stamp} from '^(.*)/[0-9]+\\.v[0-9]+$') = ${table.reference}
            AND ${entityVersions.deletedAt} IS NULL
        )`,
      },
      with: {
        client: {
          columns: {
            id: true,
            type: true,
            displayName: true,
            color: true,
          },
        },
      },
    }),
  );

  if (!result) {
    return status(404);
  }

  // The matter row, its client card, and the stamped-version count; nothing
  // else. This response used to carry the whole server `LIMITS` table (~7 KiB)
  // on one of the hottest reads in the app, so every new server-side bound
  // inflated every matter load. The two bounds the client actually reads are
  // static product constants it imports from `@stll/api-contract`. Anything
  // genuinely per-org or plan-dependent belongs here as a named subset, never
  // a spread of a table.
  return result;
};

/** `GET /v1/workspaces/:workspaceId`: one matter, archived ones included. */
const readWorkspace = createSafeHandler(
  {
    contract: "patch",
    description:
      "Read one matter, active or archived: its name, reference, status, " +
      "colour, lead and client, and stampedVersionCount, how many live " +
      "document versions carry its reference in a stamp, which a new " +
      "reference cannot rewrite.",
    access: "read",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    workspaceStatus: "active-or-archived",
    mcp: { type: "covered", by: "list_matters" },
  } satisfies WorkspaceHandlerConfig,
  async function* ({ scopedDb, session, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readWorkspaceHandler({
            workspaceId,
            organizationId: session.activeOrganizationId,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export default readWorkspace;
