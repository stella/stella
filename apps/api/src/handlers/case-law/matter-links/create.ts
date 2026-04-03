import { count, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { caseLawMatterLinks } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const createMatterLinkBodySchema = t.Object({
  decisionId: tNanoid,
  note: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
});

type CreateMatterLinkBody = Static<typeof createMatterLinkBodySchema>;

type CreateMatterLinkProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  body: CreateMatterLinkBody;
};

export const createMatterLinkHandler = async ({
  scopedDb,
  workspaceId,
  userId,
  body,
}: CreateMatterLinkProps) => {
  const decision = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: body.decisionId },
      columns: { id: true },
    }),
  );

  if (!decision) {
    return status(404, { message: "Decision not found" });
  }

  const [linkCountRow] = await scopedDb((tx) =>
    tx
      .select({ value: count() })
      .from(caseLawMatterLinks)
      .where(eq(caseLawMatterLinks.workspaceId, workspaceId)),
  );

  const linkCount = linkCountRow?.value ?? 0;

  if (linkCount >= LIMITS.caseLawMatterLinksPerWorkspace) {
    return status(400, {
      message: "Matter links limit reached",
    });
  }

  const links = await scopedDb((tx) =>
    tx
      .insert(caseLawMatterLinks)
      .values({
        decisionId: body.decisionId,
        workspaceId,
        note: body.note ?? null,
        linkedBy: userId,
      })
      .onConflictDoNothing({
        target: [caseLawMatterLinks.decisionId, caseLawMatterLinks.workspaceId],
      })
      .returning(),
  );
  const link = links.at(0);

  if (!link) {
    return status(409, {
      message: "Decision already linked to this matter",
    });
  }

  return link;
};
