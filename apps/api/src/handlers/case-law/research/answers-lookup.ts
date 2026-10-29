import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { caseLawResearchAnswers } from "@/api/db/schema";
import {
  lookupResearchAnswersBodySchema,
  toResearchAnswerResponse,
} from "@/api/handlers/case-law/research/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import { LIMITS } from "@/api/lib/limits";

const config = {
  contract: "patch",
  description:
    "The organization's answer cells for the decisions a client has on " +
    "screen, every question column at once. Bounded by the decisions named " +
    "and the columns the organization holds; the client polls this while any " +
    "cell is pending.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "search_ui" },
  body: lookupResearchAnswersBodySchema,
} satisfies HandlerConfig;

type ReadResearchAnswersOptions = {
  safeDb: SafeDb;
  readCopies?: typeof readWithdrawnCopyProjection | undefined;
  organizationId: SafeId<"organization">;
  decisionIds: SafeId<"caseLawDecision">[];
};

export const readResearchAnswers = async ({
  safeDb,
  readCopies = readWithdrawnCopyProjection,
  organizationId,
  decisionIds,
}: ReadResearchAnswersOptions) =>
  await Result.gen(async function* () {
    const rows = yield* Result.await(
      safeDb(
        async (tx) =>
          await tx
            .select()
            .from(caseLawResearchAnswers)
            .where(
              and(
                inArray(caseLawResearchAnswers.decisionId, decisionIds),
                eq(caseLawResearchAnswers.organizationId, organizationId),
              ),
            )
            // The held-column ceiling preserves every cell for existing columns.
            .limit(
              decisionIds.length *
                LIMITS.caseLawResearchColumnsPerOrganizationMax,
            ),
      ),
    );
    const withdrawal = yield* Result.await(
      Result.tryPromise(async () => await readCopies({ values: rows })),
    );
    const now = new Date();
    return Result.ok(
      rows.map((row) =>
        toResearchAnswerResponse(
          row,
          now,
          withdrawal.marker(row, row.decisionId),
        ),
      ),
    );
  });

export const createLookupResearchAnswers = ({
  readCopies,
}: Pick<ReadResearchAnswersOptions, "readCopies"> = {}) =>
  createSafeRootHandler(config, async function* ({ body, safeDb, session }) {
    const answers = yield* Result.await(
      readResearchAnswers({
        safeDb,
        readCopies,
        organizationId: session.activeOrganizationId,
        decisionIds: [...new Set(body.decisionIds)],
      }),
    );
    return Result.ok({ items: answers });
  });

export default createLookupResearchAnswers();
