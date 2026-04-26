import { Result } from "better-result";
import { eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb, Transaction } from "@/api/db";
import { clauseCategories, clauses, clauseVersions } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS, LIMITS } from "@/api/lib/limits";

import { isClauseExportPayload } from "./import-export-schema";
import { updateSearchVector } from "./search-vector";

const importBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.dataImport }),
});

type ImportProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: { file: File };
};

const importHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  body: { file },
}: ImportProps) {
  const text = await file.text();

  const parseResult = Result.try((): unknown => JSON.parse(text));
  if (Result.isError(parseResult)) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid JSON file" }),
    );
  }

  const parsed = parseResult.value;
  if (!isClauseExportPayload(parsed)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid clause export format. Expected version 1.",
      }),
    );
  }

  if (parsed.clauses.length > LIMITS.clauseImportBatchLimit) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Too many clauses. Maximum ${LIMITS.clauseImportBatchLimit} per import.`,
      }),
    );
  }

  if (parsed.clauses.length === 0) {
    return Result.ok({ created: 0, skipped: 0, errors: [] });
  }

  // Check org limit
  const existingCount = yield* Result.await(
    safeDb((tx) =>
      tx.$count(clauses, eq(clauses.organizationId, organizationId)),
    ),
  );

  const available = LIMITS.clausesPerOrganization - existingCount;
  if (available <= 0) {
    return Result.err(
      new HandlerError({ status: 400, message: "Clause limit reached" }),
    );
  }

  // Load existing categories for matching
  const allCategories = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauseCategories.findMany({
        where: { organizationId: { eq: organizationId } },
        columns: { id: true, name: true, parentId: true },
      }),
    ),
  );

  const categoryByName = new Map(
    allCategories.map((c) => [c.name.toLowerCase(), c]),
  );

  // Auto-create missing categories (uses tx for atomicity)
  const findOrCreateCategory = async (
    tx: Transaction,
    name: string,
  ): Promise<SafeId<"clauseCategory"> | null> => {
    const key = name.toLowerCase();
    const existing = categoryByName.get(key);
    if (existing) {
      return existing.id;
    }

    if (categoryByName.size >= LIMITS.clauseCategoriesCount) {
      return null;
    }

    const id = createSafeId<"clauseCategory">();
    await tx.insert(clauseCategories).values({
      id,
      organizationId,
      name,
    });

    categoryByName.set(key, {
      id,
      name,
      parentId: null,
    });
    return id;
  };

  const toProcess = parsed.clauses.slice(0, available);
  const skipped = parsed.clauses.length - toProcess.length;

  // All-or-nothing: a single failing insert rolls back everything.
  // PostgreSQL aborts the transaction on any error, so try/catch
  // inside the callback would silently corrupt subsequent statements.
  const result = yield* Result.await(
    safeDb(async (tx) => {
      const insertedIds: SafeId<"clause">[] = [];

      for (const item of toProcess) {
        const clauseId = createSafeId<"clause">();
        const versionId = createSafeId<"clauseVersion">();

        let categoryId: SafeId<"clauseCategory"> | null = null;
        if (item.categoryName) {
          categoryId = await findOrCreateCategory(tx, item.categoryName);
        }

        await tx.insert(clauses).values({
          id: clauseId,
          organizationId,
          categoryId,
          title: item.title,
          description: item.description ?? null,
          usageNotes: item.usageNotes ?? null,
          language: item.language ?? null,
          body: item.body,
          metadata: item.metadata ?? null,
          currentVersion: 1,
          createdBy: userId,
        });

        await tx.insert(clauseVersions).values({
          id: versionId,
          organizationId,
          clauseId,
          version: 1,
          body: item.body,
        });

        insertedIds.push(clauseId);
      }

      return { count: insertedIds.length, insertedIds };
    }),
  );

  // Best-effort search vector updates outside tx
  if (result.insertedIds.length > 0) {
    const newClauses = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: clauses.id,
            title: clauses.title,
            description: clauses.description,
            body: clauses.body,
          })
          .from(clauses)
          .where(inArray(clauses.id, result.insertedIds)),
      ),
    );

    for (const c of newClauses) {
      void updateSearchVector(safeDb, c.id, c.title, c.description, c.body)
        .then((searchVectorResult) => {
          if (Result.isError(searchVectorResult)) {
            captureError(searchVectorResult.error, { clauseId: c.id });
          }
        })
        .catch((error: unknown) => {
          captureError(error, { clauseId: c.id });
        });
    }
  }

  return Result.ok({ created: result.count, skipped, errors: [] });
};

const config = {
  permissions: { clause: ["create"] },
  body: importBodySchema,
} satisfies HandlerConfig;

const importClauses = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body }) {
    return yield* importHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      body,
    });
  },
);

export default importClauses;
