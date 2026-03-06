import { count, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
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
  workspaceId: SafeId<"workspace">;
  userId: string;
  body: CreateMatterLinkBody;
};

export const createMatterLinkHandler = async ({
  workspaceId,
  userId,
  body,
}: CreateMatterLinkProps) => {
  const decision = await db.query.caseLawDecisions.findFirst({
    where: { id: body.decisionId },
    columns: { id: true },
  });

  if (!decision) {
    return status(404, { message: "Decision not found" });
  }

  const [{ value: linkCount }] = await db
    .select({ value: count() })
    .from(caseLawMatterLinks)
    .where(eq(caseLawMatterLinks.workspaceId, workspaceId));

  if (linkCount >= LIMITS.caseLawMatterLinksPerWorkspace) {
    return status(400, {
      message: "Matter links limit reached",
    });
  }

  const [link] = await db
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
    .returning();

  if (!link) {
    return status(409, {
      message: "Decision already linked to this matter",
    });
  }

  return link;
};
