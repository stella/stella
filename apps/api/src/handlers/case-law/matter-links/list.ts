import { db } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ListMatterLinksProps = {
  workspaceId: SafeId<"workspace">;
};

export const listMatterLinksHandler = async ({
  workspaceId,
}: ListMatterLinksProps) => {
  const links = await db.query.caseLawMatterLinks.findMany({
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
  });

  return { links };
};
