import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import {
  clauseCategories,
  clauses,
  clauseVariants,
  clauseVersions,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ClauseParagraph } from "@/api/lib/clauses/types";
import { CSV_PARSE_STATUS, parseCSV } from "@/api/lib/csv";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS, LIMITS } from "@/api/lib/limits";

import { deriveClauseSlug, parseClauseTags } from "./clause-csv";
import { isClauseExportPayload } from "./import-export-schema";
import { normalizeClauseMetadata } from "./metadata";
import { buildClauseSearchVector } from "./search-vector";

const importBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.dataImport }),
});

const CLAUSE_CSV_TEXT_LIMIT = 256;

type ImportProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: { file: File };
  recordAuditEvent: AuditRecorder;
};

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

    const toProcess = parsed.clauses.slice(0, available);
    const skipped = parsed.clauses.length - toProcess.length;
    const categoriesToInsert: {
      id: SafeId<"clauseCategory">;
      name: string;
      organizationId: SafeId<"organization">;
    }[] = [];
    const categoryAuditEvents: AuditEvent[] = [];

    for (const { categoryName } of toProcess) {
      if (!categoryName) {
        continue;
      }

      const key = categoryName.toLowerCase();
      if (
        categoryByName.has(key) ||
        categoryByName.size >= LIMITS.clauseCategoriesCount
      ) {
        continue;
      }

      const id = createSafeId<"clauseCategory">();
      categoriesToInsert.push({ id, name: categoryName, organizationId });
      categoryByName.set(key, { id, name: categoryName, parentId: null });
      categoryAuditEvents.push({
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CLAUSE_CATEGORY,
        resourceId: id,
        changes: {
          created: {
            old: null,
            new: { name: categoryName, parentId: null },
          },
        },
        metadata: { source: "import" },
      });
    }

    const errors: string[] = [];
    const prepared = toProcess.map((item) => {
      const clauseId = createSafeId<"clause">();
      const categoryId = item.categoryName
        ? (categoryByName.get(item.categoryName.toLowerCase())?.id ?? null)
        : null;
      const allVariants = arrayOrEmpty(item.variants);
      const variants = allVariants.slice(0, LIMITS.clauseVariantsPerClause);
      if (allVariants.length > variants.length) {
        errors.push(
          `Clause "${item.title}": kept ${variants.length} of ${allVariants.length} variants (max ${LIMITS.clauseVariantsPerClause} per clause).`,
        );
      }

      return {
        auditEvent: {
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
        } satisfies AuditEvent,
        clause: {
          id: clauseId,
          organizationId,
          categoryId,
          title: item.title,
          description: item.description ?? null,
          usageNotes: item.usageNotes ?? null,
          language: item.language ?? null,
          body: item.body,
          metadata: normalizeClauseMetadata(item.metadata) ?? null,
          searchVector: buildClauseSearchVector(
            item.title,
            item.description,
            item.body,
          ),
          currentVersion: 1,
          createdBy: userId,
        },
        variants: variants.map((variant, sortOrder) => ({
          id: createSafeId<"clauseVariant">(),
          organizationId,
          clauseId,
          label: variant.label,
          body: variant.body,
          sortOrder,
        })),
        version: {
          id: createSafeId<"clauseVersion">(),
          organizationId,
          clauseId,
          version: 1,
          body: item.body,
        },
      };
    });

    const result = yield* Result.await(
      safeDb(async (tx) => {
        if (categoriesToInsert.length > 0) {
          await tx.insert(clauseCategories).values(categoriesToInsert);
        }

        await tx.insert(clauses).values(prepared.map(({ clause }) => clause));
        await tx
          .insert(clauseVersions)
          .values(prepared.map(({ version }) => version));

        const variants = prepared.flatMap((item) => item.variants);
        if (variants.length > 0) {
          await tx.insert(clauseVariants).values(variants);
        }

        await recordAuditEvent(tx, [
          ...categoryAuditEvents,
          ...prepared.map(({ auditEvent }) => auditEvent),
        ]);

        return { count: prepared.length };
      }),
    );

    return Result.ok({ created: result.count, skipped, errors });
  }

  const csvResult = parseCSV(text);
  if (csvResult.status === CSV_PARSE_STATUS.INVALID) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid CSV file" }),
    );
  }

  const parsedRows = csvResult.rows;
  const firstRow = parsedRows.at(0);
  if (!firstRow) {
    return Result.err(
      new HandlerError({ status: 400, message: "Empty CSV file" }),
    );
  }

  const headers = firstRow.map((header, index) => {
    const normalized = index === 0 ? header.replace(/^\uFEFF/u, "") : header;
    return normalized.trim().toLowerCase();
  });
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
        message:
          "Missing required CSV headers. Required: slug, title, body, tags",
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
  for (const [index, row] of dataRows.entries()) {
    if (row.length !== headers.length) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Row ${index + 2}: Expected ${headers.length} columns, received ${row.length}`,
        }),
      );
    }

    const titleVal = row[titleIndex]?.trim() ?? "";
    const bodyVal = row[bodyIndex]?.trim() ?? "";
    const slugVal = row[slugIndex]?.trim() ?? "";

    if (!titleVal || titleVal.length > CLAUSE_CSV_TEXT_LIMIT) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Row ${index + 2}: Title is required and must be under ${CLAUSE_CSV_TEXT_LIMIT} characters`,
        }),
      );
    }

    if (!bodyVal) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Row ${index + 2}: Body is required`,
        }),
      );
    }

    if (slugVal.length > CLAUSE_CSV_TEXT_LIMIT) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Row ${index + 2}: Slug must be under ${CLAUSE_CSV_TEXT_LIMIT} characters`,
        }),
      );
    }
  }

  const toProcess = dataRows.slice(0, available);
  const skipped = dataRows.length - toProcess.length;
  const prepared = toProcess.map((row) => {
    const title = (row[titleIndex] ?? "").trim();
    const body = (row[bodyIndex] ?? "").trim();
    const providedSlug = (row[slugIndex] ?? "").trim();
    const serializedTags = (row[tagsIndex] ?? "").trim();
    const clauseId = createSafeId<"clause">();
    const paragraphs: ClauseParagraph[] = body
      .split(/\r?\n/u)
      .map((line) => ({ text: line }));
    const metadata = {
      version: 1 as const,
      custom: {
        slug: deriveClauseSlug(title, clauseId, providedSlug),
        tags: parseClauseTags(serializedTags),
      },
    };

    return {
      auditEvent: {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CLAUSE,
        resourceId: clauseId,
        changes: {
          created: {
            old: null,
            new: {
              title,
              categoryId: null,
              language: null,
              currentVersion: 1,
            },
          },
        },
        metadata: { source: "import" },
      } satisfies AuditEvent,
      clause: {
        id: clauseId,
        organizationId,
        categoryId: null,
        title,
        description: null,
        usageNotes: null,
        language: null,
        body: paragraphs,
        metadata: normalizeClauseMetadata(metadata) ?? null,
        searchVector: buildClauseSearchVector(title, null, paragraphs),
        currentVersion: 1,
        createdBy: userId,
      },
      version: {
        id: createSafeId<"clauseVersion">(),
        organizationId,
        clauseId,
        version: 1,
        body: paragraphs,
      },
    };
  });

  const result = yield* Result.await(
    safeDb(async (tx) => {
      await tx.insert(clauses).values(prepared.map(({ clause }) => clause));
      await tx
        .insert(clauseVersions)
        .values(prepared.map(({ version }) => version));
      await recordAuditEvent(
        tx,
        prepared.map(({ auditEvent }) => auditEvent),
      );

      return { count: prepared.length };
    }),
  );

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
