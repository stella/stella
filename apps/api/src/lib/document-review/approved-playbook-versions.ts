/**
 * Reading the approved snapshot a run pins itself to.
 *
 * Every surface that starts a review — one document, one playbook over a
 * table, the whole matter, the classification trigger — must resolve the same
 * snapshot for the same playbook, or two reviews of one document would be
 * measured against different standards. So the read lives here once instead of
 * being restated per call site.
 */

import { and, desc, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { playbookDefinitionVersions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { PlaybookVersionForPin } from "@/api/lib/document-review/resolve-playbook-pin";

type LoadArgs = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
};

/**
 * The newest approved snapshot of each requested playbook, by definition id.
 *
 * One `DISTINCT ON` rather than a query per playbook: the auto-run resolves a
 * pin for every applicable playbook in the org, and a per-playbook read would
 * grow the round-trips with the library. The result is bounded by the id list
 * the caller passes.
 */
export const loadLatestApprovedVersions = async ({
  tx,
  organizationId,
  playbookDefinitionIds,
}: LoadArgs & {
  playbookDefinitionIds: readonly SafeId<"playbookDefinition">[];
}): Promise<Map<SafeId<"playbookDefinition">, PlaybookVersionForPin>> => {
  const byDefinitionId = new Map<
    SafeId<"playbookDefinition">,
    PlaybookVersionForPin
  >();
  if (playbookDefinitionIds.length === 0) {
    return byDefinitionId;
  }

  const rows = await tx
    .selectDistinctOn([playbookDefinitionVersions.playbookDefinitionId], {
      playbookDefinitionId: playbookDefinitionVersions.playbookDefinitionId,
      id: playbookDefinitionVersions.id,
      name: playbookDefinitionVersions.name,
      positions: playbookDefinitionVersions.positions,
    })
    .from(playbookDefinitionVersions)
    .where(
      and(
        inArray(playbookDefinitionVersions.playbookDefinitionId, [
          ...playbookDefinitionIds,
        ]),
        eq(playbookDefinitionVersions.organizationId, organizationId),
      ),
    )
    .orderBy(
      playbookDefinitionVersions.playbookDefinitionId,
      desc(playbookDefinitionVersions.version),
    )
    // `DISTINCT ON` already yields at most one row per requested playbook;
    // stating it as a limit keeps the bound visible in the query itself.
    .limit(playbookDefinitionIds.length);

  for (const row of rows) {
    byDefinitionId.set(row.playbookDefinitionId, {
      id: row.id,
      name: row.name,
      positions: row.positions,
    });
  }
  return byDefinitionId;
};

/** The newest approved snapshot of one playbook, or null when it has never
 *  been approved. */
export const loadLatestApprovedVersion = async ({
  tx,
  organizationId,
  playbookDefinitionId,
}: LoadArgs & {
  playbookDefinitionId: SafeId<"playbookDefinition">;
}): Promise<PlaybookVersionForPin | null> => {
  const versions = await loadLatestApprovedVersions({
    tx,
    organizationId,
    playbookDefinitionIds: [playbookDefinitionId],
  });
  return versions.get(playbookDefinitionId) ?? null;
};
