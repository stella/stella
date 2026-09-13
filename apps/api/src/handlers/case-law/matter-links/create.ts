import { panic, Result } from "better-result";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import { linkDecisionsToMatter } from "@/api/handlers/case-law/matter-links/link-writes";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";

export const createMatterLinkBodySchema = t.Object({
  decisionId: tSafeId("caseLawDecision"),
  note: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
});

type CreateMatterLinkBody = Static<typeof createMatterLinkBodySchema>;

type CreateMatterLinkProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  body: CreateMatterLinkBody;
  recordAuditEvent: AuditRecorder;
};

export const createMatterLinkHandler = async ({
  scopedDb,
  workspaceId,
  userId,
  body,
  recordAuditEvent,
}: CreateMatterLinkProps) => {
  const outcome = await scopedDb(
    async (tx) =>
      await linkDecisionsToMatter({
        tx,
        workspaceId,
        userId,
        items: [body],
        recordAuditEvent,
      }),
  );

  const link = outcome.linked.at(0) ?? outcome.existing.at(0);
  if (link !== undefined) {
    return link;
  }

  const rejection =
    outcome.rejected.at(0) ?? panic("Matter link had no outcome");
  switch (rejection.reason) {
    case "not_found":
      return status(404, { message: "Decision not found" });
    case "limit":
      return status(400, { message: "Matter links limit reached" });
    default: {
      rejection.reason satisfies never;
      return panic(`Unhandled rejection: ${String(rejection.reason)}`);
    }
  }
};

const config = {
  description:
    "Link one case-law decision from the corpus to the current matter, with " +
    "an optional note. A decision that is not in the corpus is a 404; a " +
    "decision already linked to this matter returns the existing link " +
    "unchanged, note included, even when the matter is full, because " +
    "re-linking adds nothing. The call is refused only when it would add a " +
    "link past the matter's maximum. To link a selection at once, use the " +
    "batch call instead of repeating this one.",
  permissions: { entity: ["create"] },
  mcp: { type: "capability", reason: "legal_corpus_admin" },
  body: createMatterLinkBodySchema,
} satisfies HandlerConfig;

const createMatterLink = createSafeHandler(
  config,
  async function* ({ body, recordAuditEvent, scopedDb, user, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await createMatterLinkHandler({
            workspaceId,
            userId: user.id,
            body,
            scopedDb,
            recordAuditEvent,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export default createMatterLink;
