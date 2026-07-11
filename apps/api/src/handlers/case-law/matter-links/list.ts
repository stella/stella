import { Result } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
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

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "legal_corpus_admin" },
} satisfies HandlerConfig;

const listMatterLinks = createSafeHandler(
  config,
  async function* ({ scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listMatterLinksHandler({
            workspaceId,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export default listMatterLinks;
