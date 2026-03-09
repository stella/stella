import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ListMatterLinksProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

export const listMatterLinksHandler = async ({
  scopedDb,
  workspaceId,
}: ListMatterLinksProps) => {
  const links = await scopedDb((tx) =>
    tx.query.caseLawMatterLinks.findMany({
      where: { workspaceId: { eq: workspaceId } },
      with: {
        decision: {
          columns: {
            id: true,
            caseNumber: true,
            ecli: true,
            court: true,
            country: true,
            decisionDate: true,
            decisionType: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      limit: LIMITS.caseLawMatterLinksPerWorkspace,
    }),
  );

  return { links };
};
