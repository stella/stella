import { Result } from "better-result";
import { eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  clauseCategories,
  clauses,
  clauseVariants,
  clauseVersions,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS, LIMITS } from "@/api/lib/limits";
import { slugify } from "@/api/handlers/skills/slug";

import { isClauseExportPayload } from "./import-export-schema";
import { normalizeClauseMetadata } from "./metadata";
import { updateSearchVector } from "./search-vector";
import type { ClauseParagraph } from "./types";

const importBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.dataImport }),
});

type ImportProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: { file: File };
  recordAuditEvent: AuditRecorder;
};

function parseCSV(text: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(cell);
        cell = "";
      } else if (char === "\r" || char === "\n") {
        row.push(cell);
        cell = "";
        if (row.length > 1 || row[0] !== "") {
          result.push(row);
        }
        row = [];
        if (char === "\r" && nextChar === "\n") {
          i++;
        }
      } else {
        cell += char;
      }
    }
  }

  if (row.length > 0 || cell !== "") {
    row.push(cell);
    result.push(row);
  }

  return result.map((r) => r.map((c) => (c.startsWith("\t") ? c.slice(1) : c)));
}

export const importHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  body: { file },
  recordAuditEvent,
}: ImportProps) {
  const text = await file.text();

  // Try parsing as JSON first
  const parseJsonResult = Result.try((): unknown => JSON.parse(text));
  if (!Result.isError(parseJsonResult)) {
    const parsed = parseJsonResult.value;
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
          limit: LIMITS.clauseCategoriesCount,
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

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CLAUSE_CATEGORY,
        resourceId: id,
        changes: {
          created: {
            old: null,
            new: { name, parentId: null },
          },
        },
        metadata: { source: "import" },
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

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const insertedIds: SafeId<"clause">[] = [];
        const auditEvents: AuditEvent[] = [];
        const errors: string[] = [];

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
            metadata: normalizeClauseMetadata(item.metadata) ?? null,
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

          const allVariants = arrayOrEmpty(item.variants);
          const variants = allVariants.slice(0, LIMITS.clauseVariantsPerClause);
          if (allVariants.length > variants.length) {
            errors.push(
              `Clause "${item.title}": kept ${variants.length} of ${allVariants.length} variants (max ${LIMITS.clauseVariantsPerClause} per clause).`,
            );
          }
          for (const [variantIndex, variant] of variants.entries()) {
            await tx.insert(clauseVariants).values({
              id: createSafeId<"clauseVariant">(),
              organizationId,
              clauseId,
              label: variant.label,
              body: variant.body,
              sortOrder: variantIndex,
            });
          }

          insertedIds.push(clauseId);
          auditEvents.push({
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.CLAUSE,
            resourceId: clauseId,
            changes: {
              created: {
                old: null,
                new: {
                  title: item.title,
                  categoryId,
                  language: item.language ?? null,
                  currentVersion: 1,
                },
              },
            },
            metadata: { source: "import" },
          });
        }

        await recordAuditEvent(tx, auditEvents);

        return { count: insertedIds.length, insertedIds, errors };
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
        updateSearchVector(safeDb, c.id, c.title, c.description, c.body)
          .then((searchVectorResult) => {
            if (Result.isError(searchVectorResult)) {
              captureError(searchVectorResult.error, { clauseId: c.id });
            }
            return;
          })
          .catch((error: unknown) => {
            captureError(error, { clauseId: c.id });
          });
      }
    }

    return Result.ok({ created: result.count, skipped, errors: result.errors });
  }

  // Parse as CSV
  const parsedRows = parseCSV(text);
  const firstRow = parsedRows[0];
  if (!firstRow) {
    return Result.err(
      new HandlerError({ status: 400, message: "Empty CSV file" }),
    );
  }

  const headers = firstRow.map((h) => h.trim().toLowerCase());
  const slugIndex = headers.indexOf("slug");
  const titleIndex = headers.indexOf("title");
  const bodyIndex = headers.indexOf("body");
  const tagsIndex = headers.indexOf("tags");

  if (
    slugIndex === -1 ||
    titleIndex === -1 ||
    bodyIndex === -1 ||
    tagsIndex === -1
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Missing required CSV headers. Required: slug, title, body, tags",
      }),
    );
  }

  const dataRows = parsedRows.slice(1);
  if (dataRows.length > LIMITS.clauseImportBatchLimit) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Too many clauses. Maximum ${LIMITS.clauseImportBatchLimit} per import.`,
      }),
    );
  }

  if (dataRows.length === 0) {
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

  // Validate all rows prior to initiating database transactions
  for (let idx = 0; idx < dataRows.length; idx++) {
    const row = dataRows[idx];
    if (!row) {
      continue;
    }
    const titleVal = row[titleIndex]?.trim() ?? "";
    const bodyVal = row[bodyIndex]?.trim() ?? "";
    const slugVal = row[slugIndex]?.trim() ?? "";

    if (!titleVal || titleVal.length > 256) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Row ${idx + 2}: Title is required and must be under 256 characters`,
        }),
      );
    }

    if (!bodyVal) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Row ${idx + 2}: Body is required`,
        }),
      );
    }

    if (slugVal.length > 256) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Row ${idx + 2}: Slug must be under 256 characters`,
        }),
      );
    }
  }

  const toProcess = dataRows.slice(0, available);
  const skipped = dataRows.length - toProcess.length;

  const result = yield* Result.await(
    safeDb(async (tx) => {
      const insertedIds: SafeId<"clause">[] = [];
      const auditEvents: AuditEvent[] = [];

      for (const row of toProcess) {
        if (!row) {
          continue;
        }
        const titleVal = (row[titleIndex] ?? "").trim();
        const bodyVal = (row[bodyIndex] ?? "").trim();
        const slugVal = (row[slugIndex] ?? "").trim();
        const tagsVal = (row[tagsIndex] ?? "").trim();

        const clauseId = createSafeId<"clause">();
        const versionId = createSafeId<"clauseVersion">();

        const paragraphs: ClauseParagraph[] = bodyVal
          .split(/\r?\n/)
          .map((line) => ({ text: line }));

        const slug = slugVal || slugify(titleVal);
        const tags = tagsVal
          ? tagsVal
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : [];

        const metadata = {
          version: 1 as const,
          custom: {
            slug,
            tags,
          },
        };

        await tx.insert(clauses).values({
          id: clauseId,
          organizationId,
          categoryId: null,
          title: titleVal,
          description: null,
          usageNotes: null,
          language: null,
          body: paragraphs,
          metadata: normalizeClauseMetadata(metadata) ?? null,
          currentVersion: 1,
          createdBy: userId,
        });

        await tx.insert(clauseVersions).values({
          id: versionId,
          organizationId,
          clauseId,
          version: 1,
          body: paragraphs,
        });

        insertedIds.push(clauseId);
        auditEvents.push({
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.CLAUSE,
          resourceId: clauseId,
          changes: {
            created: {
              old: null,
              new: {
                title: titleVal,
                categoryId: null,
                language: null,
                currentVersion: 1,
              },
            },
          },
          metadata: { source: "import" },
        });
      }

      await recordAuditEvent(tx, auditEvents);

      return { count: insertedIds.length, insertedIds };
    }),
  );

  // Best-effort search vector updates
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
      updateSearchVector(safeDb, c.id, c.title, c.description, c.body)
        .then((searchVectorResult) => {
          if (Result.isError(searchVectorResult)) {
            captureError(searchVectorResult.error, { clauseId: c.id });
          }
          return;
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
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  body: importBodySchema,
} satisfies HandlerConfig;

const importClauses = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    return yield* importHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      body,
      recordAuditEvent,
    });
  },
);

export default importClauses;
