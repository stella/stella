import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { clauses, clauseVersions } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import { normalizeClauseMetadata } from "./metadata";
import { updateSearchVector } from "./search-vector";
import { clauseBodySchema } from "./shared-schemas";
import type { ClauseBody } from "./types";

const createClauseBodySchema = t.Object({
  title: tDefaultVarchar,
  categoryId: t.Optional(tSafeId("clauseCategory")),
  language: t.Optional(t.String({ maxLength: 10 })),
  body: clauseBodySchema,
  description: t.Optional(t.String({ maxLength: 2000 })),
  usageNotes: t.Optional(t.String({ maxLength: 2000 })),
  metadata: t.Optional(t.Record(t.String(), t.Unknown())),
});

type CreateClauseProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: {
    title: string;
    categoryId?: SafeId<"clauseCategory">;
    language?: string;
    body: ClauseBody;
    description?: string;
    usageNotes?: string;
    metadata?: Record<string, unknown>;
  };
  recordAuditEvent: AuditRecorder;
};

const createClauseHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  body,
  recordAuditEvent,
}: CreateClauseProps) {
  const existingCount = yield* Result.await(
    safeDb((tx) =>
      tx.$count(clauses, eq(clauses.organizationId, organizationId)),
    ),
  );

  if (existingCount >= LIMITS.clausesPerOrganization) {
    return Result.err(
      new HandlerError({ status: 400, message: "Clause limit reached" }),
    );
  }

  if (body.categoryId) {
    const category = yield* Result.await(
      safeDb((tx) =>
        tx.query.clauseCategories.findFirst({
          where: {
            id: { eq: body.categoryId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true },
        }),
      ),
    );

    if (!category) {
      return Result.err(
        new HandlerError({ status: 404, message: "Category not found" }),
      );
    }
  }

  const clauseId = createSafeId<"clause">();
  const versionId = createSafeId<"clauseVersion">();

  const inserted = yield* Result.await(
    safeDb(async (tx) => {
      const [row] = await tx
        .insert(clauses)
        .values({
          id: clauseId,
          organizationId,
          categoryId: body.categoryId ?? null,
          title: body.title,
          description: body.description ?? null,
          usageNotes: body.usageNotes ?? null,
          language: body.language ?? null,
          body: body.body,
          metadata: normalizeClauseMetadata(body.metadata) ?? null,
          currentVersion: 1,
          createdBy: userId,
        })
        .returning({
          id: clauses.id,
          title: clauses.title,
          categoryId: clauses.categoryId,
          currentVersion: clauses.currentVersion,
          createdAt: clauses.createdAt,
        });

      await tx.insert(clauseVersions).values({
        id: versionId,
        organizationId,
        clauseId,
        version: 1,
        body: body.body,
      });

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CLAUSE,
        resourceId: clauseId,
        changes: {
          created: {
            old: null,
            new: {
              title: body.title,
              categoryId: body.categoryId ?? null,
              language: body.language ?? null,
              currentVersion: 1,
            },
          },
        },
      });

      return row;
    }),
  );

  // Best-effort: if the search vector update fails the clause
  // is still persisted; it will be unsearchable until the next
  // update re-indexes it.
  const searchVectorResult = await updateSearchVector(
    safeDb,
    clauseId,
    body.title,
    body.description,
    body.body,
  );
  if (Result.isError(searchVectorResult)) {
    captureError(searchVectorResult.error, { clauseId });
  }

  if (!inserted) {
    panic("Failed to create clause");
  }

  return Result.ok(inserted);
};

const config = {
  permissions: { clause: ["create"] },
  body: createClauseBodySchema,
} satisfies HandlerConfig;

const createClause = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    return yield* createClauseHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      body,
      recordAuditEvent,
    });
  },
);

export default createClause;
